import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentVideoRuntime } from "@framekit/runtime";

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

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function createMcpServer(runtime: AgentVideoRuntime): McpServer {
  const server = new McpServer({ name: "framekit", version: "0.1.0" });

  server.registerTool("project.inspect", {
    description: "Read the current canonical project snapshot.",
  }, async () => jsonResult(await runtime.inspectProject()));

  server.registerTool("editor.inspect", {
    description: "Read editor identity and machine-readable Phase 2 capabilities.",
  }, async () => jsonResult(await runtime.inspectEditor()));

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
