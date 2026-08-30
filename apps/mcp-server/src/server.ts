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
const editOperationSchema = z.discriminatedUnion("type", [
  renameClipSchema,
  trimClipSchema,
  setGainSchema,
  rippleDeleteSchema,
  addMarkerSchema,
]);
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
    role: z.enum(["video", "music"]),
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
};
const fillerRemovalInputSchema = {
  baseRevision: revisionValueSchema,
  range: rangeSchema,
  confidenceThreshold: z.number().finite().min(0).max(1).optional(),
  preservePauseMs: z.number().finite().nonnegative().optional(),
  targetPauseMs: z.number().finite().nonnegative().optional(),
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
const exportExpectationSchema = z.object({
  durationSeconds: z.number().positive().optional(),
  durationToleranceSeconds: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  frameRateTolerance: z.number().nonnegative().optional(),
  hasAudio: z.boolean().optional(),
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

export interface McpServerOptions {
  connectionStatus?: () => unknown;
  nativeEditor?: NativeFinalCutEditor;
  disposableNative?: Pick<DisposableNativeEditWorkflow, "preview" | "execute" | "undo">;
  projectPublisher?: FinalCutProjectPublisher;
  videoExporter?: FinalCutVideoExporter;
}

export function createMcpServer(runtime: AgentVideoRuntime, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "framekit", version: "0.1.0" });

  server.registerTool("connection.status", {
    description: "Read Framekit's Final Cut connection state, setup progress, and live capabilities.",
    inputSchema: {},
  }, async () => jsonResult(normalizeConnectionStatus(options.connectionStatus?.() ?? {
    state: "ready",
    editorDetected: false,
    extensionInstalled: false,
    socketPath: null,
    capabilities: null,
    lastError: null,
  })));

  server.registerTool("project.inspect", {
    description: "Read the current canonical project snapshot.",
  }, async () => jsonResult(await runtime.inspectProject()));

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
    description: "Read editor identity and machine-readable Phase 2 capabilities.",
  }, async () => {
    const inspected = await runtime.inspectEditor();
    const native = options.nativeEditor?.capabilities();
    return jsonResult({
      ...inspected,
      capabilities: withCapabilityFamilies({
        ...inspected.capabilities,
        editor: {
          ...inspected.capabilities.editor,
          timelinePublishNewProject: Boolean(options.projectPublisher),
          videoExport: Boolean(options.videoExporter?.isAvailable()),
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
          timelineFocus: Boolean(native?.timelineFocus),
          projectCreation: false,
          clipInsertion: false,
          clipMovement: false,
        },
        publishing: Boolean(options.projectPublisher),
        publishingBackend: "fcpxml-publisher",
        export: Boolean(options.videoExporter?.isAvailable()),
        exportBackend: "final-cut-native-export",
      }),
      ...(native ? { native } : {}),
    });
  });

  server.registerTool("editing.intent.resolve", {
    description: "Map a supported natural-language editing request to one explicit operation without executing it.",
    inputSchema: { request: z.string().trim().min(1) },
  }, async ({ request }) => jsonResult(resolveEditingIntent(request)));

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

  server.registerTool("timeline.publish.new-project", {
    description: "Import the validated FCPXML artifact as a new Final Cut project without replacing the active project.",
    inputSchema: { transactionId: z.string().min(1) },
  }, async ({ transactionId }) => {
    if (!options.projectPublisher) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing requires FRAMEKIT_FCPXML_PATH and native writes");
    const verification = await runtime.verifyTransaction(transactionId);
    if (!verification.passed) throw new Error(`FINAL_CUT_PUBLISH_VALIDATION_FAILED: source transaction ${transactionId} did not pass verification`);
    return jsonResult(await options.projectPublisher.publishNewProject(transactionId));
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
    description: "Apply one supported edit and return read-after-write plus its diff.",
    inputSchema: editToolInputSchema,
  }, async (input) => jsonResult(await runtime.edit(editOperationSchema.parse(input))));

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
    description: "Validate and preview one ordered, atomic Basic Editing MVP workflow without mutating the project.",
    inputSchema: {
      baseRevision: revisionValueSchema,
      operations: workflowOperationsSchema,
    },
  }, async (request) => jsonResult(await runtime.previewEdit(request)));

  server.registerTool("timeline.edit.execute", {
    description: "Execute one short-lived composite edit preview token exactly once and verify the transaction.",
    inputSchema: { previewToken: z.string().min(1) },
  }, async ({ previewToken }) => jsonResult(await runtime.executeEdit(previewToken)));

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
