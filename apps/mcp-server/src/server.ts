import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AgentVideoRuntime,
  resolveEditingIntent,
  withCapabilityFamilies,
  type RuntimeCapabilities,
  type TimelineFrameCapture,
} from "@framekit/runtime";
import type {
  DisposableNativeEditWorkflow,
  FinalCutProjectPublisher,
  FinalCutVideoExporter,
  NativeFinalCutEditor,
} from "@framekit/final-cut";
import {
  EDITOR_FIRST_MCP_INSTRUCTIONS,
  resolveEditingRoute,
  type EditorRoutingContext,
  type EditingRouteOperation,
} from "./routing.js";

const revisionValueSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
});
const revisionSchema = revisionValueSchema.optional();
const rationalTimeSchema = z.object({
  value: z.string().regex(/^-?\d+$/),
  timescale: z.string().regex(/^\d+$/).refine((value) => Number(value) > 0),
});
const rangeSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
});
const mediaIndexQuerySchema = z.object({
  query: z.string().optional(),
  subject: z.string().optional(),
  scene: z.string().optional(),
  environment: z.string().optional(),
  timeOfDay: z.string().optional(),
  mood: z.string().optional(),
  motion: z.enum(["static", "low", "medium", "high"]).optional(),
  range: rangeSchema.optional(),
  capabilities: z.array(z.enum(["metadata", "speech", "audio", "visual"])).optional(),
});
const roughCutPlanSchema = mediaIndexQuerySchema.extend({
  maxShots: z.number().int().positive().optional(),
});
const durationRangeSchema = z.object({
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
});
const durationPolicyInputSchema = z.object({
  requestedDurationSeconds: z.number().finite().positive(),
  footage: z.array(z.object({
    id: z.string().trim().min(1),
    durationSeconds: z.number().finite().positive(),
    usableDurationSeconds: z.number().finite().positive().optional(),
    usableRanges: z.array(durationRangeSchema).optional(),
    reusable: z.boolean().optional(),
  })),
  constraint: z.enum(["hard", "soft"]).optional(),
  permissions: z.object({
    allowReuse: z.boolean().optional(),
    allowSlowMotion: z.boolean().optional(),
    allowGeneratedAssets: z.boolean().optional(),
  }).optional(),
  actualDurationSeconds: z.number().finite().nonnegative().optional(),
});
const markerSchema = z.object({
    id: z.string().min(1),
    start: z.number().nonnegative(),
    duration: z.number().nonnegative(),
    name: z.string().min(1),
});
const renameClipSchema = z.object({ type: z.literal("rename-clip"), clipId: z.string().min(1), name: z.string().min(1), baseRevision: revisionSchema });
const trimClipSchema = z.object({
    type: z.literal("trim-clip"),
    clipId: z.string().min(1),
    duration: z.number().positive(),
    durationTime: rationalTimeSchema.optional(),
    baseRevision: revisionSchema,
});
const setGainSchema = z.object({ type: z.literal("set-gain"), clipId: z.string().min(1), gainDb: z.number().finite(), baseRevision: revisionSchema });
const rippleDeleteSchema = z.object({ type: z.literal("ripple-delete"), timelineId: z.string().min(1), range: rangeSchema, reason: z.string().optional(), baseRevision: revisionSchema });
const addMarkerSchema = z.object({ type: z.literal("add-marker"), timelineId: z.string().min(1), marker: markerSchema, baseRevision: revisionSchema });
const roughCutImportSchema = z.object({
  type: z.literal("media.import"),
  mediaId: z.string().min(1),
  source: z.string().min(1),
  mediaKind: z.literal("video"),
  duration: z.number().positive(),
  sourceDigest: z.string().min(1),
});
const roughCutShotSchema = z.object({
  occurrenceId: z.string().min(1),
  mediaId: z.string().min(1),
  duration: z.number().positive().optional(),
});
const roughCutConstructionPlanInputSchema = {
  baseRevision: revisionValueSchema,
  imports: z.array(roughCutImportSchema).optional(),
  shots: z.array(roughCutShotSchema).min(1),
};
const editOperationSchema = z.discriminatedUnion("type", [
  renameClipSchema,
  trimClipSchema,
  setGainSchema,
  rippleDeleteSchema,
  addMarkerSchema,
]);
const verificationAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio-audibility"),
    mediaId: z.string().min(1),
    minAudibleSamples: z.number().int().positive().optional(),
    maxSilenceMs: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-coverage"),
    mediaId: z.string().min(1),
    start: z.number().finite().nonnegative(),
    duration: z.number().finite().positive(),
    toleranceSeconds: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-loudness"),
    mediaId: z.string().min(1),
    targetLufs: z.number().finite(),
    toleranceDb: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-source"),
    mediaId: z.string().min(1),
    sourceDigest: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("visual-content"),
    mediaId: z.string().min(1),
    label: z.string().min(1),
    labelKind: z.enum(["scene", "subject"]).optional(),
    minConfidence: z.number().finite().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("duration"),
    target: z.literal("timeline"),
    expectedSeconds: z.number().finite().nonnegative(),
    toleranceSeconds: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("stream"),
    target: z.enum(["audio", "video"]),
    expected: z.boolean(),
  }),
  z.object({
    type: z.literal("structure"),
    requirement: z.enum(["media-present", "occurrence-present", "operation-present"]),
    mediaId: z.string().min(1).optional(),
    occurrenceId: z.string().min(1).optional(),
    operationType: z.string().min(1).optional(),
  }),
]);
const verificationPolicySchema = z.object({
  requireExpectedChange: z.boolean().optional(),
  maxTruePeakDb: z.number().finite().optional(),
  requireSpeechContinuity: z.boolean().optional(),
  targetLufs: z.number().finite().optional(),
  loudnessToleranceDb: z.number().finite().nonnegative().optional(),
  assertions: z.array(verificationAssertionSchema).optional(),
}).strict();
const editToolInputSchema = z.object({
  type: z.enum(["rename-clip", "trim-clip", "set-gain", "ripple-delete", "add-marker"]),
  clipId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  duration: z.number().positive().optional(),
  durationTime: rationalTimeSchema.optional(),
  gainDb: z.number().finite().optional(),
  timelineId: z.string().min(1).optional(),
  range: rangeSchema.optional(),
  reason: z.string().optional(),
  marker: markerSchema.optional(),
  baseRevision: revisionSchema,
  verification: verificationPolicySchema.optional(),
}).strict();
const artifactEditToolInputSchema = editToolInputSchema.extend({
  artifactPath: z.string().trim().min(1),
  baseRevision: revisionValueSchema,
}).strict();
const editorTimelineEditToolInputSchema = editToolInputSchema.extend({
  projectId: z.string().trim().min(1),
  sequenceId: z.string().trim().min(1),
  baseRevision: revisionValueSchema,
}).strict();
const artifactPublishInputSchema = z.object({
  artifactPath: z.string().trim().min(1),
  transactionId: z.string().min(1),
  confirm: z.boolean(),
}).strict();
const workflowOperationSchema = z.discriminatedUnion("type", [
  renameClipSchema,
  trimClipSchema,
  setGainSchema,
  rippleDeleteSchema,
  addMarkerSchema,
  z.object({
    type: z.literal("media.import"),
    mediaId: z.string().min(1),
    source: z.string().min(1),
    mediaKind: z.enum(["video", "audio"]),
    duration: z.number().positive(),
    sourceDigest: z.string().min(1),
  }),
  z.object({
    type: z.literal("timeline.media.add"),
    occurrenceId: z.string().min(1),
    mediaId: z.string().min(1),
    role: z.enum(["video", "music", "audio"]),
    start: z.number().nonnegative(),
    duration: z.number().positive(),
    targetLane: z.union([z.literal("primary"), z.number().int()]).optional(),
  }),
  z.object({
    type: z.literal("timeline.audio.fades"),
    clipId: z.string().min(1),
    fadeIn: z.number().nonnegative(),
    fadeOut: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("timeline.title.add"),
    occurrenceId: z.string().min(1),
    assetId: z.string().min(1),
    text: z.string().min(1),
    start: z.number().nonnegative(),
    duration: z.number().positive(),
    targetLane: z.number().int().refine((lane) => lane !== 0, "title requires a non-primary lane"),
  }),
  z.object({
    type: z.literal("timeline.media.move"),
    occurrenceId: z.string().min(1),
    start: z.number().nonnegative(),
    targetLane: z.union([z.literal("primary"), z.number().int()]).optional(),
  }),
  z.object({
    type: z.literal("timeline.media.replace"),
    occurrenceId: z.string().min(1),
    mediaId: z.string().min(1),
    duration: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("timeline.media.remove"),
    occurrenceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("timeline.transition.add"),
    transitionId: z.string().min(1),
    assetId: z.string().min(1),
    beforeClipId: z.string().min(1),
    afterClipId: z.string().min(1),
    duration: z.number().positive(),
  }),
  z.object({
    type: z.literal("timeline.audio.attach"),
    occurrenceId: z.string().min(1),
    targetClipId: z.string().min(1),
    mediaId: z.string().min(1),
    startOffset: z.number().nonnegative().optional(),
    duration: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("timeline.audio.mix"),
    clipId: z.string().min(1),
    gainDb: z.number().finite().optional(),
    fadeIn: z.number().nonnegative().optional(),
    fadeOut: z.number().nonnegative().optional(),
  }),
]);
const workflowOperationsSchema = z.array(workflowOperationSchema).min(1).superRefine((operations, context) => {
  operations.forEach((operation, index) => {
    if (operation.type === "timeline.media.add" && operation.role === "video"
      && operation.targetLane !== undefined && operation.targetLane !== "primary") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "targetLane"], message: "video must target the primary storyline" });
    }
    if (operation.type === "timeline.media.add" && operation.role === "music"
      && (typeof operation.targetLane !== "number" || operation.targetLane === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "targetLane"], message: "music requires an explicit non-primary lane" });
    }
    if (operation.type === "timeline.media.add" && operation.role === "audio"
      && (typeof operation.targetLane !== "number" || operation.targetLane === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "targetLane"], message: "audio requires an explicit non-primary lane" });
    }
    if (operation.type === "timeline.audio.mix"
      && operation.gainDb === undefined && operation.fadeIn === undefined && operation.fadeOut === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "audio mix requires a gain or fade change" });
    }
  });
});
const musicImportSchema = z.object({
  mediaId: z.string().min(1),
  source: z.string().min(1),
  duration: z.number().positive(),
  sourceDigest: z.string().min(1),
});
const musicDuckingSchema = z.object({
  enabled: z.boolean(),
  dialogueClipIds: z.array(z.string().min(1)).optional(),
  reductionDb: z.number().finite().optional(),
});
const musicAddInputSchema = {
  baseRevision: revisionValueSchema,
  occurrenceId: z.string().min(1),
  mediaId: z.string().min(1).optional(),
  import: musicImportSchema.optional(),
  placement: z.enum(["append", "insert"]),
  start: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  targetLane: z.number().int().refine((lane) => lane !== 0, "music requires a non-primary lane"),
  gainDb: z.number().finite().optional(),
  fadeIn: z.number().nonnegative().optional(),
  fadeOut: z.number().nonnegative().optional(),
  ducking: musicDuckingSchema.optional(),
  verification: verificationPolicySchema.optional(),
};
const fillerRemovalInputSchema = {
  baseRevision: revisionValueSchema,
  range: rangeSchema,
  confidenceThreshold: z.number().finite().min(0).max(1).optional(),
  preservePauseMs: z.number().finite().nonnegative().optional(),
  targetPauseMs: z.number().finite().nonnegative().optional(),
};
const dialogueNormalizationInputSchema = {
  mediaId: z.string().min(1),
  occurrenceId: z.string().min(1),
  baseRevision: revisionValueSchema,
  targetLufs: z.number().finite(),
  toleranceDb: z.number().finite().nonnegative(),
  maxTruePeakDb: z.number().finite(),
  minGainDb: z.number().finite(),
  maxGainDb: z.number().finite(),
  minDialogueDurationSeconds: z.number().finite().nonnegative(),
};
const nativeEditSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename-selected-clip"), name: z.string().min(1) }),
  z.object({ type: z.literal("trim-selected-clip-to-playhead"), edge: z.enum(["start", "end"]) }),
  z.object({ type: z.literal("set-selected-clip-gain"), gainDb: z.number().finite() }),
  z.object({ type: z.literal("add-marker-at-playhead"), name: z.string().min(1), duration: z.number().nonnegative().optional() }),
]);
const disposableNativePreviewSchema = {
  clipId: z.string().min(1),
  name: z.string().min(1),
  baseRevision: revisionValueSchema.optional(),
};
const nativeTitlePreviewSchema = {
  assetId: z.string().min(1),
  text: z.string().trim().min(1),
  start: rationalTimeSchema.optional(),
  duration: rationalTimeSchema,
};
const nativeTransitionPreviewSchema = {
  assetId: z.string().min(1),
  beforeOccurrenceHandle: z.string().min(1),
  afterOccurrenceHandle: z.string().min(1),
  duration: rationalTimeSchema,
};
const exportAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio-audibility"),
    minAudibleSamples: z.number().int().positive().optional(),
    maxSilenceMs: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-coverage"),
    expectedSeconds: z.number().finite().positive(),
    toleranceSeconds: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-loudness"),
    targetLufs: z.number().finite(),
    toleranceDb: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("audio-source"),
    sourceDigest: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("visual-content"),
    label: z.string().min(1),
    labelKind: z.enum(["scene", "subject"]).optional(),
    minConfidence: z.number().finite().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("stream"),
    target: z.enum(["audio", "video"]),
    expected: z.boolean(),
  }),
]);
const exportExpectationSchema = z.object({
  durationSeconds: z.number().positive().optional(),
  durationToleranceSeconds: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  frameRateTolerance: z.number().nonnegative().optional(),
  hasAudio: z.boolean().optional(),
  assertions: z.array(exportAssertionSchema).optional(),
}).optional();
const nativeEditToolInputSchema = z.object({
  type: z.enum([
    "rename-selected-clip",
    "trim-selected-clip-to-playhead",
    "set-selected-clip-gain",
    "add-marker-at-playhead",
  ]),
  name: z.string().min(1).optional(),
  edge: z.enum(["start", "end"]).optional(),
  gainDb: z.number().finite().optional(),
  duration: z.number().nonnegative().optional(),
}).strict();

const skillIds = ["filler-removal", "dialogue-normalization"] as const;
const skillIdSchema = z.enum(skillIds);
const skillManifests = [
  {
    id: "filler-removal",
    version: 1,
    description: "Remove high-confidence filler words through a guarded closed-loop transaction.",
    previewTool: "skill.preview",
    executeTool: "skill.execute",
    requires: ["canonical timeline read", "speech analysis", "ripple-delete", "rollback"],
  },
  {
    id: "dialogue-normalization",
    version: 1,
    description: "Normalize one complete dialogue clip occurrence with measured loudness and peak verification.",
    previewTool: "skill.preview",
    executeTool: "skill.execute",
    requires: ["canonical timeline read", "dialogue audio analysis", "set-gain", "rollback"],
  },
] as const;

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function normalizeConnectionStatus(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const status = value as Record<string, unknown>;
  if (!isRuntimeCapabilities(status.capabilities)) return value;
  const identity = status.identity && typeof status.identity === "object"
    ? status.identity as { backend?: unknown }
    : undefined;
  const backend = typeof identity?.backend === "string" ? identity.backend : undefined;
  return {
    ...status,
    capabilities: withCapabilityFamilies(status.capabilities, {
      ...(backend ? { backend, connectionBackend: backend } : {}),
      connection: status.state === "ready",
    }),
  };
}

function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  return isRecord(capabilities.editor) && isRecord(capabilities.analyzers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function frameResult(value: TimelineFrameCapture) {
  const { data, mimeType, ...imageMetadata } = value.image;
  return {
    content: [
      { type: "image" as const, data, mimeType },
      {
        type: "text" as const,
        text: JSON.stringify({
          ...value,
          image: { mimeType, ...imageMetadata },
        }),
      },
    ],
  };
}

export interface McpConnectionStatus {
  state: string;
  lastError?: { code: string; message: string };
  editorDetected?: boolean;
  extensionInstalled?: boolean;
  socketPath?: string | null;
  capabilities?: unknown;
}

export interface McpServerOptions {
  connectionStatus?: () => McpConnectionStatus | undefined | Promise<McpConnectionStatus | undefined>;
  nativeEditor?: NativeFinalCutEditor;
  disposableNative?: Pick<DisposableNativeEditWorkflow, "preview" | "execute" | "undo">;
  projectPublisher?: FinalCutProjectPublisher;
  videoExporter?: FinalCutVideoExporter;
}

export function createMcpServer(runtime: AgentVideoRuntime, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "framekit", version: "0.1.0" },
    { instructions: EDITOR_FIRST_MCP_INSTRUCTIONS },
  );

  server.registerTool("connection.status", {
    description: "Read Framekit's Final Cut connection state before editor-first capability discovery.",
    inputSchema: {},
  }, async () => jsonResult(normalizeConnectionStatus(await connectionStatus(options))));

  server.registerTool("skill.list", {
    description: "List versioned Framekit Skills available through the generic MCP surface.",
    inputSchema: {},
  }, async () => jsonResult(skillManifests));

  server.registerTool("skill.inspect", {
    description: "Inspect one versioned Framekit Skill and its generic preview and execute tools.",
    inputSchema: { skill: skillIdSchema },
  }, async ({ skill }) => jsonResult(skillManifests.find((manifest) => manifest.id === skill)));

  server.registerTool("skill.preview", {
    description: "Preview a versioned Framekit Skill through its generic MCP contract without mutating the editor.",
    inputSchema: {
      skill: skillIdSchema,
      arguments: z.record(z.unknown()),
    },
  }, async ({ skill, arguments: skillArguments }) => {
    if (skill === "filler-removal") {
      return jsonResult(await runtime.previewFillerRemoval(z.object(fillerRemovalInputSchema).parse(skillArguments)));
    }
    return jsonResult(await runtime.previewDialogueNormalization(
      z.object(dialogueNormalizationInputSchema).parse(skillArguments),
    ));
  });

  server.registerTool("skill.execute", {
    description: "Execute one generic Framekit Skill preview token and return its verified or rolled-back transaction.",
    inputSchema: {
      skill: skillIdSchema,
      previewToken: z.string().min(1),
    },
  }, async ({ skill, previewToken }) => jsonResult(skill === "filler-removal"
    ? await runtime.executeFillerRemoval(previewToken)
    : await runtime.executeDialogueNormalization(previewToken)));

  server.registerTool("project.inspect", {
    description: "Read the current canonical project snapshot before editing.route selects a capability-checked path.",
  }, async () => jsonResult(await runtime.inspectProject()));

  server.registerTool("artifact.inspect", {
    description: "Identify the managed FCPXML artifact used by artifact.edit and artifact.publish.",
    inputSchema: {},
  }, async () => jsonResult(await runtime.inspectArtifact()));

  server.registerTool("project.list", {
    description: "List projects and their stable Final Cut sequence identities, including the active target.",
    inputSchema: {},
  }, async () => jsonResult(await runtime.listProjects()));

  server.registerTool("project.select", {
    description: "Select one project and, when it has multiple sequences, one explicit sequence; ambiguous targets fail closed.",
    inputSchema: {
      projectId: z.string().min(1),
      sequenceId: z.string().min(1).optional(),
    },
  }, async ({ projectId, sequenceId }) => jsonResult(await runtime.selectProject({ projectId, sequenceId })));

  server.registerTool("editor.inspect", {
    description: "Read editor identity and machine-readable capabilities before selecting an editing path.",
  }, async () => {
    const inspected = await inspectMcpEditor(runtime, options);
    const capabilities = inspected.capabilities as RuntimeCapabilities & {
      editor: RuntimeCapabilities["editor"] & { artifactPublish?: boolean };
    };
    return jsonResult({
      ...inspected,
      capabilities: {
        ...capabilities,
        editor: {
          ...capabilities.editor,
          artifactPublish: Boolean(
            capabilities.editor.artifactPublish ?? capabilities.editor.timelinePublishNewProject,
          ),
        },
      },
    });
  });

  server.registerTool("editing.intent.resolve", {
    description: "Map a supported natural-language editing request to one explicit operation without executing it.",
    inputSchema: { request: z.string().trim().min(1) },
  }, async ({ request }) => jsonResult(resolveEditingIntent(request)));

  server.registerTool("editing.route", {
    description: "Resolve an editor-first path after capability checks; never bypass a connected editor, and require explicit external fallback selection.",
    inputSchema: {
      operation: z.enum([
        "timeline.edit",
        "editor.native.edit",
        "timeline.publish.new-project",
        "timeline.export",
      ]),
      fallback: z.enum(["none", "external-renderer"]).optional().default("none"),
    },
  }, async ({ operation, fallback }) => {
    const context = await editingRouteContext(runtime, options);
    return jsonResult(resolveEditingRoute({ operation, fallback }, context));
  });

  server.registerTool("editing.duration.plan", {
    description: "Plan requested duration against unique footage and return explicit quality-preserving alternatives without editing.",
    inputSchema: durationPolicyInputSchema,
  }, async (request) => jsonResult(runtime.planDuration(request)));

  server.registerTool("editor.native.inspect", {
    description: "Inspect the active Final Cut selection/playhead before a native UI edit.",
    inputSchema: {},
  }, async () => jsonResult(options.nativeEditor
    ? await options.nativeEditor.inspect()
    : { available: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "Final Cut native writes are not configured" } }));

  server.registerTool("editor.native.focus", {
    description: "Activate Final Cut Pro and focus its timeline without changing project or timeline content.",
    inputSchema: {},
  }, async () => jsonResult(options.nativeEditor
    ? await options.nativeEditor.focusTimeline()
    : { available: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "Final Cut native writes are not configured" } }));

  server.registerTool("editor.native.media.import", {
    description: "Import one local video or audio file into the active Final Cut Browser and wait for a stable media handle.",
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media import is not configured");
    return jsonResult(await options.nativeEditor.importMedia(path));
  });

  server.registerTool("editor.native.edit", {
    description: "Apply a guarded native Final Cut UI edit to the active selection or playhead.",
    inputSchema: nativeEditToolInputSchema,
  }, async (input) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are not configured");
    const operation = nativeEditSchema.parse(input);
    return jsonResult(await options.nativeEditor.edit(operation));
  });

  server.registerTool("editor.native.disposable.preview", {
    description: "Preview a disposable native Final Cut rename after canonical target, revision, and native preflight checks.",
    inputSchema: disposableNativePreviewSchema,
  }, async ({ clipId, name, baseRevision }) => {
    if (!options.disposableNative) throw new Error("CAPABILITY_UNAVAILABLE: disposable native edit is not configured");
    return jsonResult(await options.disposableNative.preview({ clipId, name, baseRevision }));
  });

  server.registerTool("editor.native.disposable.execute", {
    description: "Execute a disposable native Final Cut edit and return canonical diff, verification, and rollback state.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.disposableNative) throw new Error("CAPABILITY_UNAVAILABLE: disposable native edit is not configured");
    return jsonResult(await options.disposableNative.execute(previewToken));
  });

  server.registerTool("editor.native.disposable.undo", {
    description: "Undo a verified disposable native Final Cut edit and verify canonical restoration.",
    inputSchema: { operationId: z.string().min(1) },
  }, async ({ operationId }) => {
    if (!options.disposableNative) throw new Error("CAPABILITY_UNAVAILABLE: disposable native edit is not configured");
    return jsonResult(await options.disposableNative.undo(operationId));
  });

  server.registerTool("editor.native.title.add.preview", {
    description: "Preview adding an installed Final Cut title at the live playhead or an explicit timeline range.",
    inputSchema: nativeTitlePreviewSchema,
  }, async ({ assetId, text, start, duration }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native title placement is not configured");
    const asset = await resolveNativeTitleAsset(runtime, assetId);
    return jsonResult(await options.nativeEditor.previewTitleAdd({ asset, text, start, duration }));
  });

  server.registerTool("editor.native.title.add.execute", {
    description: "Execute a previously previewed native Final Cut title placement and return its verification and Undo handle.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native title placement is not configured");
    return jsonResult(await options.nativeEditor.executeTitleAdd(previewToken));
  });

  server.registerTool("editor.native.transition.search", {
    description: "Search the visible Final Cut Transitions browser and return only transitions with stable native identities.",
    inputSchema: { query: z.string().trim().min(1) },
  }, async ({ query }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native transition discovery is not configured");
    return jsonResult(await options.nativeEditor.searchTransitions(query));
  });

  server.registerTool("editor.native.transition.add.preview", {
    description: "Preview adding a discovered native transition between two adjacent occurrence handles at an exact duration.",
    inputSchema: nativeTransitionPreviewSchema,
  }, async ({ assetId, beforeOccurrenceHandle, afterOccurrenceHandle, duration }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native transition placement is not configured");
    const asset = await resolveNativeTransitionAsset(runtime, options.nativeEditor, assetId);
    return jsonResult(await options.nativeEditor.previewTransitionAdd({
      asset,
      beforeOccurrenceHandle,
      afterOccurrenceHandle,
      duration,
    }));
  });

  server.registerTool("editor.native.transition.add.execute", {
    description: "Execute a previously previewed native transition placement and return verified revision and Undo state.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native transition placement is not configured");
    return jsonResult(await options.nativeEditor.executeTransitionAdd(previewToken));
  });

  server.registerTool("editor.native.undo", {
    description: "Undo a previously accepted native Final Cut UI edit using Final Cut's native Undo command.",
    inputSchema: { operationId: z.string().min(1) },
  }, async ({ operationId }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are not configured");
    return jsonResult(await options.nativeEditor.undo(operationId));
  });

  server.registerTool("editor.native.media.search", {
    description: "Search the active Final Cut Browser for live media and return short-lived media handles.",
    inputSchema: { query: z.string().min(1) },
  }, async ({ query }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media search is not configured");
    return jsonResult(await options.nativeEditor.searchMedia(query));
  });

  server.registerTool("editor.native.media.select", {
    description: "Select one live Final Cut Browser media result using its short-lived handle.",
    inputSchema: { mediaHandle: z.string().min(1) },
  }, async ({ mediaHandle }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media selection is not configured");
    return jsonResult(await options.nativeEditor.selectMedia(mediaHandle));
  });

  server.registerTool("editor.native.media.append.preview", {
    description: "Preview appending the selected Final Cut Browser media to the end of the active timeline.",
    inputSchema: { mediaHandle: z.string().min(1) },
  }, async ({ mediaHandle }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media append is not configured");
    return jsonResult(await options.nativeEditor.previewAppendMedia(mediaHandle));
  });

  server.registerTool("editor.native.media.append.execute", {
    description: "Execute a previously previewed append of selected Final Cut Browser media.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media append is not configured");
    return jsonResult(await options.nativeEditor.executeAppendMedia(previewToken));
  });

  server.registerTool("editor.native.media.append.selected.preview", {
    description: "Preview appending the currently selected Final Cut Browser media to the end of the active timeline.",
    inputSchema: {},
  }, async () => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native selected-media append is not configured");
    return jsonResult(await options.nativeEditor.previewAppendSelectedMedia());
  });

  server.registerTool("editor.native.media.append.selected.execute", {
    description: "Execute a previously previewed append of the currently selected Final Cut Browser media.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native selected-media append is not configured");
    return jsonResult(await options.nativeEditor.executeAppendSelectedMedia(previewToken));
  });

  server.registerTool("editor.native.media.insert.preview", {
    description: "Preview inserting the selected Final Cut Browser media at the current playhead.",
    inputSchema: { mediaHandle: z.string().min(1) },
  }, async ({ mediaHandle }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media insert is not configured");
    return jsonResult(await options.nativeEditor.previewInsertMedia(mediaHandle));
  });

  server.registerTool("editor.native.media.insert.execute", {
    description: "Execute a previously previewed insertion of selected Final Cut Browser media at the playhead.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media insert is not configured");
    return jsonResult(await options.nativeEditor.executeInsertMedia(previewToken));
  });

  server.registerTool("editor.native.timeline.locate", {
    description: "Locate matching occurrences of a live Browser media result in the active Final Cut timeline.",
    inputSchema: { mediaHandle: z.string().min(1) },
  }, async ({ mediaHandle }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut timeline occurrence location is not configured");
    return jsonResult(await options.nativeEditor.locateOccurrence(mediaHandle));
  });

  server.registerTool("editor.native.media.target", {
    description: "Search Final Cut's Browser and target exactly one timeline occurrence with a deterministic live playhead.",
    inputSchema: { query: z.string().min(1) },
  }, async ({ query }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native media targeting is not configured");
    return jsonResult(await options.nativeEditor.targetMedia(query));
  });

  server.registerTool("editor.native.blade.preview", {
    description: "Prepare a short-lived confirmation token for a Blade-at-playhead operation.",
    inputSchema: { occurrenceHandle: z.string().min(1) },
  }, async ({ occurrenceHandle }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native Blade is not configured");
    return jsonResult(await options.nativeEditor.previewBlade(occurrenceHandle));
  });

  server.registerTool("editor.native.blade.execute", {
    description: "Execute a previously previewed Blade-at-playhead operation in Final Cut Pro.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native Blade is not configured");
    return jsonResult(await options.nativeEditor.executeBlade(previewToken));
  });

  server.registerTool("editor.native.delete-range.preview", {
    description: "Preview a destructive ripple-delete of an explicit rational time range from the Final Cut primary storyline.",
    inputSchema: { start: rationalTimeSchema, end: rationalTimeSchema },
  }, async ({ start, end }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native range deletion is not configured");
    return jsonResult(await options.nativeEditor.previewDeleteRange({ start, end }));
  });

  server.registerTool("editor.native.delete-range.execute", {
    description: "Execute a previously previewed primary-storyline ripple-delete range operation in Final Cut Pro.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native range deletion is not configured");
    return jsonResult(await options.nativeEditor.executeDeleteRange(previewToken));
  });

  server.registerTool("editor.native.trim-to-duration.preview", {
    description: "Preview a destructive operation that preserves the beginning of the Final Cut sequence and removes everything after the requested rational duration.",
    inputSchema: { duration: rationalTimeSchema },
  }, async ({ duration }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native duration trimming is not configured");
    return jsonResult(await options.nativeEditor.previewTrimToDuration(duration));
  });

  server.registerTool("editor.native.trim-to-duration.execute", {
    description: "Execute a previously previewed trim-to-duration operation in Final Cut Pro.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native duration trimming is not configured");
    return jsonResult(await options.nativeEditor.executeTrimToDuration(previewToken));
  });

  server.registerTool("artifact.publish", {
    description: "Import the validated FCPXML artifact as a new Final Cut project without replacing the active project; requires explicit confirmation.",
    inputSchema: artifactPublishInputSchema,
  }, async ({ artifactPath, transactionId, confirm }) => {
    if (!options.projectPublisher) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing requires FRAMEKIT_FCPXML_PATH and native writes");
    const transaction = runtime.getTransaction(transactionId);
    if (transaction.target?.kind !== "artifact" || transaction.target.artifactPath !== artifactPath) {
      throw new Error(`PUBLISH_TARGET_MISMATCH: transaction ${transactionId} is not verified for artifact ${artifactPath}`);
    }
    if (!transaction.artifactDigest) {
      throw new Error(`PUBLISH_SOURCE_CHANGED: transaction ${transactionId} has no immutable artifact digest`);
    }
    const verification = await runtime.verifyTransaction(transactionId);
    if (!verification.passed) throw new Error(`FINAL_CUT_PUBLISH_VALIDATION_FAILED: source transaction ${transactionId} did not pass verification`);
    return jsonResult(await options.projectPublisher.publishNewProject({
      sourceTransactionId: transactionId,
      artifactPath,
      artifactDigest: transaction.artifactDigest,
      confirm,
    }));
  });

  server.registerTool("timeline.publish.new-project", {
    description: "Legacy alias for publishing a verified artifact transaction as a new Final Cut project.",
    inputSchema: { transactionId: z.string().min(1) },
  }, async ({ transactionId }) => {
    if (!options.projectPublisher?.isAvailable()) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing requires FRAMEKIT_FCPXML_PATH and native writes");
    const transaction = runtime.getTransaction(transactionId);
    if (transaction.target?.kind !== "artifact") {
      throw new Error(`PUBLISH_TARGET_MISMATCH: transaction ${transactionId} is not verified for a managed artifact`);
    }
    if (!transaction.artifactDigest) {
      throw new Error(`PUBLISH_SOURCE_CHANGED: transaction ${transactionId} has no immutable artifact digest`);
    }
    const verification = await runtime.verifyTransaction(transactionId);
    if (!verification.passed) throw new Error(`FINAL_CUT_PUBLISH_VALIDATION_FAILED: source transaction ${transactionId} did not pass verification`);
    return jsonResult(await options.projectPublisher.publishNewProject({
      sourceTransactionId: transactionId,
      artifactPath: transaction.target.artifactPath,
      artifactDigest: transaction.artifactDigest,
      confirm: true,
    }));
  });

  server.registerTool("timeline.export", {
    description: "Export the active Final Cut timeline to a local video file, wait for completion, and verify its media metadata.",
    inputSchema: {
      outputPath: z.string().trim().min(1),
      preset: z.enum(["master", "web"]),
      overwrite: z.boolean().optional(),
      expected: exportExpectationSchema,
    },
  }, async ({ outputPath, preset, overwrite, expected }) => {
    if (!options.videoExporter?.isAvailable()) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut video export is not configured");
    return jsonResult(await options.videoExporter.exportVideo({ outputPath, preset, overwrite, expected }));
  });

  server.registerTool("context.inspect", {
    description: "Read the queryable agent editing context and its current revision.",
    inputSchema: {},
  }, async () => jsonResult(await runtime.inspectContext()));

  server.registerTool("context.changes", {
    description: "Read incremental timeline, live-state, and native-asset changes after a context revision.",
    inputSchema: {
      sequence: z.number().int().nonnegative(),
      waitMs: z.number().int().min(0).max(30_000).optional(),
    },
  }, async ({ sequence, waitMs }) => jsonResult(await runtime.contextChangesSince({
    id: `rev-${sequence}`,
    sequence,
    timestamp: new Date(sequence).toISOString(),
  }, waitMs ?? 0)));

  server.registerTool("editor.live.inspect", {
    description: "Read live Final Cut Workflow Extension state: project, active sequence, playhead, and selected range.",
    inputSchema: {},
  }, async () => jsonResult(await runtime.inspectLiveEditor()));

  server.registerTool("editor.live.changes", {
    description: "Read live Final Cut timeline change events after a revision; optionally wait for new events.",
    inputSchema: {
      sequence: z.number().int().nonnegative(),
      waitMs: z.number().int().min(0).max(30_000).optional(),
    },
  }, async ({ sequence, waitMs }) => jsonResult(await runtime.liveChangesSince({
    id: `rev-${sequence}`,
    sequence,
    timestamp: new Date(sequence).toISOString(),
  }, waitMs ?? 0)));

  server.registerTool("timeline.inspect", {
    description: "Read the current canonical timeline snapshot.",
  }, async () => jsonResult(await runtime.inspectTimeline()));

  server.registerTool("timeline.frame.capture", {
    description: "Capture an image at an exact timeline position with project, sequence, clip, and optional visual-analysis metadata.",
    inputSchema: {
      position: rationalTimeSchema,
      analyze: z.boolean().optional(),
    },
  }, async ({ position, analyze }) => frameResult(await runtime.captureFrame(position, { analyze })));

  server.registerTool("media.inspect", {
    description: "Read normalized context and available analysis for one media item.",
    inputSchema: { mediaId: z.string().min(1) },
  }, async ({ mediaId }) => jsonResult(await runtime.inspectMedia(mediaId)));

  server.registerTool("media.search", {
    description: "Search normalized media references by id or source path.",
    inputSchema: { query: z.string() },
  }, async ({ query }) => jsonResult(await runtime.searchMedia(query)));

  server.registerTool("media.index", {
    description: "Query analyzed media by semantic properties, source identity, capabilities, and usable ranges.",
    inputSchema: mediaIndexQuerySchema.shape,
  }, async (query) => jsonResult(await runtime.indexMedia(query)));

  server.registerTool("visual.analyze", {
    description: "Analyze scenes, subjects, motion, and keyframes for one media item.",
    inputSchema: {
      mediaId: z.string().min(1),
      range: rangeSchema.optional(),
    },
  }, async ({ mediaId, range }) => jsonResult(await runtime.analyzeVisual(mediaId, range)));

  server.registerTool("media.understand", {
    description: "Return combined speech, audio, and visual understanding for one media item.",
    inputSchema: { mediaId: z.string().min(1) },
  }, async ({ mediaId }) => jsonResult(await runtime.understandMedia(mediaId)));

  server.registerTool("rough-cut.plan", {
    description: "Create a deterministic, explainable, read-only shot plan from analyzed media; does not mutate the timeline.",
    inputSchema: roughCutPlanSchema.shape,
  }, async (request) => jsonResult(await runtime.planRoughCut(request)));

  server.registerTool("editor.assets", {
    description: "Search editor-native transitions, effects, titles, generators, and templates.",
    inputSchema: {
      query: z.string().optional(),
      kind: z.enum(["transition", "effect", "title", "generator", "audio-effect", "template"]).optional(),
      vendor: z.string().optional(),
    },
  }, async (query) => jsonResult(await runtime.listAssets(query)));

  server.registerTool("timeline.changes", {
    description: "Return the canonical timeline diff since a previously observed revision.",
    inputSchema: { sequence: z.number().int().nonnegative() },
  }, async ({ sequence }) => {
    const project = await runtime.inspectProject();
    return jsonResult(await runtime.changesSince({
      id: `rev-${sequence}`,
      sequence,
      timestamp: new Date(0 + sequence).toISOString(),
    }));
  });

  server.registerTool("timeline.edit", {
    description: "Apply one supported edit after editing.route confirms the required capabilities; return read-after-write plus its diff.",
    inputSchema: editToolInputSchema,
  }, async (input) => {
    await requireEditingRoute(runtime, options, "timeline.edit");
    return jsonResult(await runtime.edit(editOperationSchema.parse(input), input.verification ?? {}));
  });

  server.registerTool("rough-cut.construction.plan", {
    description: "Build a deterministic ordered rough-cut construction plan without changing the active project.",
    inputSchema: roughCutConstructionPlanInputSchema,
  }, async (request) => jsonResult(await runtime.planRoughCutConstruction(request)));

  server.registerTool("rough-cut.construction.preview", {
    description: "Preview a deterministic rough cut with capability and revision checks before execution.",
    inputSchema: roughCutConstructionPlanInputSchema,
  }, async (request) => jsonResult(await runtime.previewRoughCutConstruction(request)));

  server.registerTool("artifact.edit", {
    description: "Edit the identified managed FCPXML artifact and return its artifact target, new revision, read-after-write, and diff.",
    inputSchema: artifactEditToolInputSchema,
  }, async (input) => {
    const { artifactPath, verification, ...operation } = input;
    return jsonResult(await runtime.editArtifact(artifactPath, editOperationSchema.parse(operation), verification ?? {}));
  });

  server.registerTool("editor.timeline.edit", {
    description: "Edit the active Final Cut project and sequence identified by IDs and base revision; return the live timeline target, read-after-write, and diff.",
    inputSchema: editorTimelineEditToolInputSchema,
  }, async (input) => {
    const { projectId, sequenceId, verification, ...operation } = input;
    return jsonResult(await runtime.editTimeline(
      { projectId, sequenceId },
      editOperationSchema.parse(operation),
      verification ?? {},
    ));
  });

  server.registerTool("music.add", {
    description: "Preview adding a searched or imported music bed with placement, gain, and fades; execute the returned token with music.add.execute.",
    inputSchema: musicAddInputSchema,
  }, async (request) => jsonResult(await runtime.previewMusic(request)));

  server.registerTool("music.add.preview", {
    description: "Preview adding a searched or imported music bed without mutating the timeline.",
    inputSchema: musicAddInputSchema,
  }, async (request) => jsonResult(await runtime.previewMusic(request)));

  server.registerTool("music.add.execute", {
    description: "Execute a previously previewed music add and return verified placement and audio state.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => jsonResult(await runtime.executeEdit(previewToken)));

  server.registerTool("timeline.edit.preview", {
    description: "Validate and preview one ordered, atomic Basic Editing MVP workflow after editing.route confirms capabilities; do not mutate the project.",
    inputSchema: {
      baseRevision: revisionValueSchema,
      operations: workflowOperationsSchema,
      verification: verificationPolicySchema.optional(),
    },
  }, async (request) => {
    await requireEditingRoute(runtime, options, "timeline.edit");
    return jsonResult(await runtime.previewEdit(request));
  });

  server.registerTool("artifact.edit.preview", {
    description: "Validate and preview an ordered artifact edit against the identified FCPXML artifact without mutating it.",
    inputSchema: {
      artifactPath: z.string().trim().min(1),
      baseRevision: revisionValueSchema,
      operations: workflowOperationsSchema,
      verification: verificationPolicySchema.optional(),
    },
  }, async ({ artifactPath, baseRevision, operations, verification }) => jsonResult(await runtime.previewArtifactEdit(
    artifactPath,
    { baseRevision, operations, ...(verification ? { verification } : {}) },
  )));

  server.registerTool("editor.timeline.edit.preview", {
    description: "Validate and preview an ordered live timeline edit against the identified active project and sequence without mutating it.",
    inputSchema: {
      projectId: z.string().trim().min(1),
      sequenceId: z.string().trim().min(1),
      baseRevision: revisionValueSchema,
      operations: workflowOperationsSchema,
      verification: verificationPolicySchema.optional(),
    },
  }, async ({ projectId, sequenceId, baseRevision, operations, verification }) => jsonResult(await runtime.previewTimelineEdit(
    { projectId, sequenceId },
    { baseRevision, operations, ...(verification ? { verification } : {}) },
  )));

  server.registerTool("artifact.edit.execute", {
    description: "Execute one short-lived artifact edit preview token exactly once and verify the artifact transaction.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => jsonResult(await runtime.executeEdit(previewToken)));

  server.registerTool("editor.timeline.edit.execute", {
    description: "Execute one short-lived live timeline edit preview token exactly once and verify the timeline transaction.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => jsonResult(await runtime.executeEdit(previewToken)));

  server.registerTool("timeline.edit.execute", {
    description: "Execute one short-lived composite edit preview token exactly once after editing.route capability checks, then verify the transaction.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => {
    await requireEditingRoute(runtime, options, "timeline.edit");
    return jsonResult(await runtime.executeEdit(previewToken));
  });

  server.registerTool("speech.analyze", {
    description: "Analyze speech words and filler markers for one media item.",
    inputSchema: { mediaId: z.string().min(1) },
  }, async ({ mediaId }) => jsonResult(await runtime.analyzeSpeech(mediaId)));

  server.registerTool("speech.filler.remove.preview", {
    description: "Analyze a selected canonical timeline range and preview removal of high-confidence filler words with safe rational delete ranges.",
    inputSchema: fillerRemovalInputSchema,
  }, async (request) => jsonResult(await runtime.previewFillerRemoval(request)));

  server.registerTool("speech.filler.remove.execute", {
    description: "Execute a previously previewed filler removal, re-analyze adjacent speech, and return the verified or rolled-back transaction.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => jsonResult(await runtime.executeFillerRemoval(previewToken)));

  server.registerTool("audio.analyze", {
    description: "Analyze loudness, true peak, and silence for one media item.",
    inputSchema: { mediaId: z.string().min(1) },
  }, async ({ mediaId }) => jsonResult(await runtime.analyzeAudio(mediaId)));

  server.registerTool("edit.diff", {
    description: "Read the deterministic diff for a completed edit transaction.",
    inputSchema: { transactionId: z.string().min(1) },
  }, async ({ transactionId }) => jsonResult(runtime.getDiff(transactionId)));

  server.registerTool("edit.verify", {
    description: "Read verification checks for a completed transaction.",
    inputSchema: { transactionId: z.string().min(1) },
  }, async ({ transactionId }) => jsonResult(await runtime.verifyTransaction(transactionId)));

  server.registerTool("edit.undo", {
    description: "Restore the pre-edit snapshot for a completed transaction.",
    inputSchema: { transactionId: z.string().min(1) },
  }, async ({ transactionId }) => jsonResult(await runtime.undo(transactionId)));

  return server;
}

async function resolveNativeTitleAsset(runtime: AgentVideoRuntime, assetId: string) {
  const assets = await runtime.listAssets();
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`TITLE_ASSET_NOT_FOUND: installed title asset ${assetId} was not discovered`);
  if (asset.kind !== "title") throw new Error(`TITLE_ASSET_INCOMPATIBLE: ${assetId} is not an installed Final Cut title asset`);
  return asset;
}

async function resolveNativeTransitionAsset(
  runtime: AgentVideoRuntime,
  nativeEditor: NativeFinalCutEditor,
  assetId: string,
) {
  let assets: Awaited<ReturnType<AgentVideoRuntime["listAssets"]>> = [];
  try {
    assets = await runtime.listAssets({ kind: "transition" });
  } catch {
    // A native-only session may not expose the runtime asset registry. Native
    // discovery below remains the source of truth in that case.
  }
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (asset) {
    return {
      id: asset.id,
      kind: "transition" as const,
      name: asset.name,
      vendor: asset.vendor,
      identity: typeof asset.metadata.nativeIdentity === "string" ? asset.metadata.nativeIdentity : asset.id,
    };
  }
  const nativeMatches = await nativeEditor.searchTransitions(assetId);
  const nativeMatch = nativeMatches.find((candidate) => candidate.id === assetId);
  if (!nativeMatch) throw new Error(`TRANSITION_ASSET_NOT_FOUND: installed transition asset ${assetId} was not discovered`);
  return nativeMatch;
}

async function connectionStatus(options: McpServerOptions): Promise<McpConnectionStatus> {
  return await options.connectionStatus?.() ?? {
    state: "ready",
    editorDetected: false,
    extensionInstalled: false,
    socketPath: null,
    capabilities: null,
  };
}

async function inspectMcpEditor(runtime: AgentVideoRuntime, options: McpServerOptions) {
  const inspected = await runtime.inspectEditor();
  const native = options.nativeEditor?.capabilities();
  const publishingAvailable = Boolean(options.projectPublisher && (
    typeof options.projectPublisher.isAvailable !== "function" || options.projectPublisher.isAvailable()
  ));
  const exportAvailable = Boolean(options.videoExporter?.isAvailable());
  return {
    ...inspected,
    capabilities: withCapabilityFamilies({
      ...inspected.capabilities,
      editor: {
        ...inspected.capabilities.editor,
        artifactPublish: publishingAvailable,
        ...(publishingAvailable ? {} : { timelinePublishNewProject: false }),
        videoExport: exportAvailable,
      },
    }, {
      backend: inspected.identity.backend,
      nativeBackend: "final-cut-accessibility",
      native: {
        selectionWrite: Boolean(native?.selectionEdit),
        undo: Boolean(native?.undo),
        mediaLibrarySearch: Boolean(native?.mediaLibrarySearch),
        mediaImport: Boolean(native?.mediaImport),
        mediaSelection: Boolean(native?.mediaSelection),
        mediaAppendSelected: Boolean(native?.mediaAppendSelected),
        timelineOccurrenceLocate: Boolean(native?.timelineOccurrenceLocate),
        bladeAtPlayhead: Boolean(native?.bladeAtPlayhead),
        deleteRange: Boolean(native?.deleteRange),
        trimToDuration: Boolean(native?.trimToDuration),
        mediaAppend: Boolean(native?.mediaAppend),
        mediaInsert: Boolean(native?.mediaInsert),
        titlePlacement: Boolean(native?.titlePlacement),
        transitionDiscovery: Boolean(native?.transitionDiscovery),
        transitionPlacement: Boolean(native?.transitionPlacement),
        timelineFocus: Boolean(native?.timelineFocus),
        projectCreation: false,
        clipInsertion: false,
        clipMovement: false,
      },
      publishing: publishingAvailable,
      publishingBackend: "fcpxml-publisher",
      export: exportAvailable,
      exportBackend: "final-cut-native-export",
    }),
    ...(native ? { native } : {}),
  };
}

async function requireEditingRoute(
  runtime: AgentVideoRuntime,
  options: McpServerOptions,
  operation: EditingRouteOperation,
): Promise<void> {
  const route = resolveEditingRoute({ operation }, await editingRouteContext(runtime, options));
  if (route.status !== "editor-selected") {
    throw new Error(`${route.reason.code}: ${route.reason.message}`);
  }
}

async function editingRouteContext(
  runtime: AgentVideoRuntime,
  options: McpServerOptions,
): Promise<EditorRoutingContext> {
  const connection = await connectionStatus(options);
  let editor: Awaited<ReturnType<typeof inspectMcpEditor>> | undefined;
  try {
    editor = await inspectMcpEditor(runtime, options);
  } catch {
    editor = undefined;
  }
  return {
    connection,
    ...(editor ? { editor } : {}),
    ...(options.nativeEditor ? { native: { ...options.nativeEditor.capabilities() } } : {}),
  };
}
