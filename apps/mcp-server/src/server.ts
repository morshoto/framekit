import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentVideoRuntime, resolveEditingIntent, type TimelineFrameCapture } from "@framekit/runtime";
import type { FinalCutProjectPublisher, FinalCutVideoExporter, NativeFinalCutEditor } from "@framekit/final-cut";

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
const nativeEditSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename-selected-clip"), name: z.string().min(1) }),
  z.object({ type: z.literal("trim-selected-clip-to-playhead"), edge: z.enum(["start", "end"]) }),
  z.object({ type: z.literal("set-selected-clip-gain"), gainDb: z.number().finite() }),
  z.object({ type: z.literal("add-marker-at-playhead"), name: z.string().min(1), duration: z.number().nonnegative().optional() }),
]);
const exportExpectationSchema = z.object({
  durationSeconds: z.number().positive().optional(),
  durationToleranceSeconds: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  frameRateTolerance: z.number().nonnegative().optional(),
  hasAudio: z.boolean().optional(),
}).optional();

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
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
  projectPublisher?: FinalCutProjectPublisher;
  videoExporter?: FinalCutVideoExporter;
}

export function createMcpServer(runtime: AgentVideoRuntime, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "framekit", version: "0.1.0" });

  server.registerTool("connection.status", {
    description: "Read Framekit's Final Cut connection state, setup progress, and live capabilities.",
    inputSchema: {},
  }, async () => jsonResult(options.connectionStatus?.() ?? {
    state: "ready",
    editorDetected: false,
    extensionInstalled: false,
    socketPath: null,
    capabilities: null,
    lastError: null,
  }));

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
    return jsonResult({
      ...inspected,
      capabilities: {
        ...inspected.capabilities,
        editor: {
          ...inspected.capabilities.editor,
          timelinePublishNewProject: Boolean(options.projectPublisher),
          videoExport: Boolean(options.videoExporter?.isAvailable()),
        },
      },
      ...(options.nativeEditor ? { native: options.nativeEditor.capabilities() } : {}),
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
    inputSchema: nativeEditSchema,
  }, async (operation) => {
    if (!options.nativeEditor) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are not configured");
    return jsonResult(await options.nativeEditor.edit(operation));
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
    inputSchema: editOperationSchema,
  }, async (operation) => jsonResult(await runtime.edit(operation)));

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
