import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentVideoRuntime } from "../core/runtime.js";
import type { EditOperation } from "../core/types.js";

const renameClipSchema = {
  type: z.enum(["rename-clip", "trim-clip", "set-gain", "ripple-delete", "add-marker"]),
  clipId: z.string().min(1).optional(),
  timelineId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  duration: z.number().positive().optional(),
  durationTime: z.object({ value: z.string(), timescale: z.string() }).optional(),
  gainDb: z.number().finite().optional(),
  range: z.object({ start: z.number().nonnegative(), end: z.number().positive() }).optional(),
  reason: z.string().optional(),
  marker: z.object({
    id: z.string().min(1),
    start: z.number().nonnegative(),
    duration: z.number().nonnegative(),
    name: z.string().min(1),
  }).optional(),
  baseRevision: z.object({
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string(),
  }).optional(),
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function createMcpServer(runtime: AgentVideoRuntime): McpServer {
  const server = new McpServer({ name: "playhead", version: "0.1.0" });

  server.registerTool("project.inspect", {
    description: "Read the current canonical project snapshot.",
  }, async () => jsonResult(await runtime.inspectProject()));

  server.registerTool("editor.inspect", {
    description: "Read editor identity and machine-readable Phase 1 capabilities.",
  }, async () => jsonResult(await runtime.inspectEditor()));

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
    description: "Analyze visual content; unavailable until the Phase 2 visual analyzer is installed.",
    inputSchema: { mediaId: z.string().min(1) },
  }, async () => jsonResult(await runtime.analyzeVisual()));

  server.registerTool("editor.assets", {
    description: "List editor-native assets when the selected backend supports discovery.",
    inputSchema: {},
  }, async () => jsonResult(await runtime.listAssets()));

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
    description: "Apply one supported Phase 0 edit and return read-after-write plus its diff.",
    inputSchema: renameClipSchema,
  }, async (operation) => jsonResult(await runtime.edit(operation as EditOperation)));

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
