import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentVideoRuntime } from "@framekit/runtime";
import type { NativeFinalCutEditor } from "@framekit/final-cut";

const revisionSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
}).optional();
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
const editOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename-clip"), clipId: z.string().min(1), name: z.string().min(1), baseRevision: revisionSchema }),
  z.object({
    type: z.literal("trim-clip"),
    clipId: z.string().min(1),
    duration: z.number().positive(),
    durationTime: rationalTimeSchema.optional(),
    baseRevision: revisionSchema,
  }),
  z.object({ type: z.literal("set-gain"), clipId: z.string().min(1), gainDb: z.number().finite(), baseRevision: revisionSchema }),
  z.object({ type: z.literal("ripple-delete"), timelineId: z.string().min(1), range: rangeSchema, reason: z.string().optional(), baseRevision: revisionSchema }),
  z.object({ type: z.literal("add-marker"), timelineId: z.string().min(1), marker: markerSchema, baseRevision: revisionSchema }),
]);
const nativeEditSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename-selected-clip"), name: z.string().min(1) }),
  z.object({ type: z.literal("trim-selected-clip-to-playhead"), edge: z.enum(["start", "end"]) }),
  z.object({ type: z.literal("set-selected-clip-gain"), gainDb: z.number().finite() }),
  z.object({ type: z.literal("add-marker-at-playhead"), name: z.string().min(1), duration: z.number().nonnegative().optional() }),
]);

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export interface McpServerOptions {
  connectionStatus?: () => unknown;
  nativeEditor?: NativeFinalCutEditor;
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

  server.registerTool("editor.inspect", {
    description: "Read editor identity and machine-readable Phase 2 capabilities.",
  }, async () => jsonResult({
    ...await runtime.inspectEditor(),
    ...(options.nativeEditor ? { native: options.nativeEditor.capabilities() } : {}),
  }));

  server.registerTool("editor.native.inspect", {
    description: "Inspect the active Final Cut selection/playhead before a native UI edit.",
    inputSchema: {},
  }, async () => jsonResult(options.nativeEditor
    ? await options.nativeEditor.inspect()
    : { available: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "Final Cut native writes are not configured" } }));

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
