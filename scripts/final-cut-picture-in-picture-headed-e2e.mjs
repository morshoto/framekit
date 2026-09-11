import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evidenceEnvironment } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const anchorQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_ANCHOR_QUERY;
const pipQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_PIP_QUERY;
const start = rational(process.env.FRAMEKIT_FINAL_CUT_E2E_PIP_START, "FRAMEKIT_FINAL_CUT_E2E_PIP_START");
const duration = rational(process.env.FRAMEKIT_FINAL_CUT_E2E_PIP_DURATION, "FRAMEKIT_FINAL_CUT_E2E_PIP_DURATION");

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Headed native Final Cut picture-in-picture E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_PROJECT=exact-project-name",
    "  FRAMEKIT_FINAL_CUT_E2E_ANCHOR_QUERY=unique-primary-browser-query",
    "  FRAMEKIT_FINAL_CUT_E2E_PIP_QUERY=unique-secondary-video-browser-query",
    "  FRAMEKIT_FINAL_CUT_E2E_PIP_START=integer/timescale",
    "  FRAMEKIT_FINAL_CUT_E2E_PIP_DURATION=integer/timescale",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!expectedProject || !anchorQuery || !pipQuery || !start || !duration) {
  throw new Error("Set the Final Cut PIP headed E2E project, queries, start, and duration variables");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-picture-in-picture-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  if (editor.identity?.name !== "Final Cut Pro" && editor.identity?.backend !== "final-cut-live") {
    throw new Error("FINAL_CUT_E2E_EDITOR_MISMATCH: expected the Final Cut live editor");
  }
  if (editor.native?.pictureInPicture !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed native picture-in-picture is not advertised");
  }

  const focused = await callJson("editor.native.focus");
  if (!focused.available || !focused.frontmost || !focused.timelineFocused) {
    throw new Error(`FINAL_CUT_NATIVE_NOT_READY: ${focused.error?.code ?? "timeline focus failed"}`);
  }
  if (focused.project && focused.project !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${focused.project}`);
  }

  const anchorMatches = await callJson("editor.native.media.search", { query: anchorQuery });
  if (!Array.isArray(anchorMatches) || anchorMatches.length !== 1) {
    throw new Error("FINAL_CUT_E2E_ANCHOR_MEDIA_AMBIGUOUS: anchor query must return exactly one Browser result");
  }
  const anchorMedia = anchorMatches[0];
  await callJson("editor.native.media.select", { mediaHandle: anchorMedia.handle });
  const located = await callJson("editor.native.timeline.locate", { mediaHandle: anchorMedia.handle });
  if (located.status !== "unique" || located.occurrences?.length !== 1) {
    throw new Error("FINAL_CUT_E2E_ANCHOR_OCCURRENCE_AMBIGUOUS: anchor query must locate exactly one timeline occurrence");
  }
  const anchorOccurrence = located.occurrences[0];

  const pipMatches = await callJson("editor.native.media.search", { query: pipQuery });
  if (!Array.isArray(pipMatches) || pipMatches.length !== 1) {
    throw new Error("FINAL_CUT_E2E_PIP_MEDIA_AMBIGUOUS: PIP query must return exactly one Browser result");
  }
  const pipMedia = pipMatches[0];
  await callJson("editor.native.media.select", { mediaHandle: pipMedia.handle });
  const preview = await callJson("editor.native.picture-in-picture.preview", {
    mediaHandle: pipMedia.handle,
    anchorOccurrenceHandle: anchorOccurrence.handle,
    start,
    duration,
    position: { x: 320, y: -180 },
    scale: 0.35,
    frame: { style: "solid", color: "#FFFFFF", width: 8 },
  });
  if (!preview.previewToken || preview.anchorOccurrence?.handle !== anchorOccurrence.handle) {
    throw new Error("FINAL_CUT_E2E_PIP_PREVIEW_FAILED: preview did not preserve stable native bindings");
  }

  const executed = await callJson("editor.native.picture-in-picture.execute", { previewToken: preview.previewToken });
  if (!executed.verification?.verified || executed.afterRevision?.id === executed.beforeRevision?.id) {
    throw new Error("FINAL_CUT_E2E_PIP_EXECUTE_FAILED: native placement was not verified");
  }
  if (executed.observed?.position?.x !== 320 || executed.observed?.position?.y !== -180 || executed.observed?.scale !== 0.35) {
    throw new Error("FINAL_CUT_E2E_PIP_READBACK_FAILED: transform readback did not match the request");
  }
  if (executed.observed?.frame?.color?.toUpperCase() !== "#FFFFFF") {
    throw new Error("FINAL_CUT_E2E_PIP_FRAME_READBACK_FAILED: white frame was not read back");
  }

  const undone = await callJson("editor.native.undo", { operationId: executed.operationId });
  if (!undone.undone || undone.verification?.verified !== true) {
    throw new Error("FINAL_CUT_E2E_PIP_UNDO_FAILED: native Undo did not verify");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceType: "headed-native-picture-in-picture",
    passed: true,
    recordedAt: new Date().toISOString(),
    environment: await evidenceEnvironment(root),
    editor: {
      name: editor.identity?.name,
      version: editor.identity?.version,
      backend: editor.identity?.backend,
    },
    capabilities: {
      nativePictureInPicture: editor.native.pictureInPicture,
      nativeUndo: editor.native.undo,
      nativeTimelineOccurrenceLocate: editor.native.timelineOccurrenceLocate,
    },
    target: {
      sequenceId: anchorOccurrence.sequenceId,
      occurrenceName: anchorOccurrence.name,
    },
    placement: {
      project: expectedProject,
      anchorMedia: { name: anchorMedia.name, sourceIdentity: anchorMedia.sourceIdentity },
      anchorOccurrence: { handle: anchorOccurrence.handle, start: anchorOccurrence.start, duration: anchorOccurrence.duration },
      pipMedia: { name: pipMedia.name, sourceIdentity: pipMedia.sourceIdentity },
      requested: { start, duration, position: { x: 320, y: -180 }, scale: 0.35, frame: { color: "#FFFFFF", width: 8 } },
      observed: executed.observed,
      beforeRevision: executed.beforeRevision,
      afterRevision: executed.afterRevision,
      operationId: executed.operationId,
      undoOperationId: undone.operationId,
      undoVerified: undone.verification,
      undoRevision: undone.context?.revision?.id,
    },
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

function rational(value, label) {
  if (!value) return undefined;
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match || Number(match[2]) <= 0) throw new Error(`${label} must use integer/timescale form`);
  return { value: match[1], timescale: match[2] };
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const output = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(output || `${name} failed`);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${output}`);
  }
}
