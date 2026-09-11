import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceEnvironment } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const maskQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_MASK_QUERY;
const mask = parseMask(process.env.FRAMEKIT_FINAL_CUT_E2E_MASK_BOUNDS ?? "0.1,0.2,0.6,0.7");

if (!expectedProject || !maskQuery) {
  throw new Error(
    "Set FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_MASK_QUERY, and optionally FRAMEKIT_FINAL_CUT_E2E_MASK_BOUNDS before running the native masking headed E2E",
  );
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-masking-headed-e2e", version: "0.1.0" });
let operationId;

try {
  await client.connect(transport);
  const toolResults = [];
  const inspected = await callJson("editor.native.inspect");
  toolResults.push({ name: "editor.native.inspect", status: "passed" });
  if (inspected.project !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${inspected.project ?? "unknown"}`);
  }
  if (!inspected.frontmost || !inspected.timelineWindowAvailable) {
    throw new Error("FINAL_CUT_E2E_TIMELINE_UNAVAILABLE: Final Cut's frontmost timeline is required");
  }
  if (inspected.native?.masking !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native bounded masking is not advertised");
  }

  const media = await uniqueMedia(maskQuery, toolResults);
  const located = await callJson("editor.native.timeline.locate", { mediaHandle: media.handle });
  toolResults.push({ name: "editor.native.timeline.locate", status: "passed" });
  if (located.status !== "unique" || !Array.isArray(located.occurrences) || located.occurrences.length !== 1) {
    throw new Error("FINAL_CUT_E2E_OCCURRENCE_AMBIGUOUS: mask query must resolve to one timeline occurrence");
  }
  const occurrence = located.occurrences[0];

  const preview = await callJson("editor.native.mask.preview", {
    occurrenceHandle: occurrence.handle,
    mask,
  });
  toolResults.push({ name: "editor.native.mask.preview", status: "passed" });
  if (!preview.previewToken || preview.command !== "Add native Draw Mask" || !preview.revision) {
    throw new Error("FINAL_CUT_E2E_MASK_PREVIEW_FAILED: preview did not return a token, command, and revision");
  }

  const executed = await callJson("editor.native.mask.execute", { previewToken: preview.previewToken });
  operationId = executed.operationId;
  toolResults.push({ name: "editor.native.mask.execute", status: executed.verification?.verified ? "passed" : "failed" });
  if (!executed.verification?.verified
    || !executed.undoAvailable
    || !executed.undoCommand
    || !sameMask(executed.mask, executed.observedMask)
    || executed.beforeRevision?.id === executed.afterRevision?.id) {
    throw new Error("FINAL_CUT_E2E_MASK_EXECUTE_FAILED: native Draw Mask was not verified with readback and a new revision");
  }

  const undone = await callJson("editor.native.undo", { operationId });
  toolResults.push({ name: "editor.native.undo", status: undone.verification?.verified ? "passed" : "failed" });
  if (!undone.undone || !undone.verification?.verified) {
    throw new Error("FINAL_CUT_E2E_MASK_UNDO_FAILED: native Undo did not verify restoration");
  }
  operationId = undefined;

  const environment = await evidenceEnvironment(root);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceType: "headed-native-mask-placement",
    passed: true,
    recordedAt: new Date().toISOString(),
    environment,
    project: expectedProject,
    target: summarizeOccurrence(preview.occurrence),
    mask: {
      requested: preview.mask,
      observed: executed.observedMask,
    },
    revisions: {
      before: executed.beforeRevision.id,
      after: executed.afterRevision.id,
      restored: undone.context?.revision?.id,
    },
    verification: {
      execute: executed.verification,
      undo: undone.verification,
    },
    undo: { available: true, command: executed.undoCommand, verified: true },
    toolResults,
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["raw native contexts", "media paths", "operation handles", "diagnostics"],
    },
  }, null, 2)}\n`);
} catch (error) {
  if (operationId) {
    try {
      await callJson("editor.native.undo", { operationId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Native masking headed E2E failed and compensating Undo also failed");
    }
  }
  throw error;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function uniqueMedia(query, toolResults) {
  const matches = await callJson("editor.native.media.search", { query });
  toolResults.push({ name: "editor.native.media.search", status: "passed" });
  if (!Array.isArray(matches) || matches.length !== 1) {
    throw new Error(`FINAL_CUT_E2E_MEDIA_AMBIGUOUS: query ${query} returned ${matches?.length ?? 0} matches`);
  }
  return matches[0];
}

async function callJson(name, arguments_ = {}) {
  const startedAt = Date.now();
  process.stderr.write(`[headed-e2e] begin ${name}\n`);
  try {
    const result = await client.callTool({ name, arguments: arguments_ });
    const text = result.content?.find((item) => item.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text || `${name} failed`);
    try {
      const parsed = JSON.parse(text);
      process.stderr.write(`[headed-e2e] end ${name} ${Date.now() - startedAt}ms\n`);
      return parsed;
    } catch {
      throw new Error(`${name} returned invalid JSON: ${text}`);
    }
  } catch (error) {
    process.stderr.write(`[headed-e2e] fail ${name} ${Date.now() - startedAt}ms: ${String(error)}\n`);
    throw error;
  }
}

function parseMask(value) {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`FINAL_CUT_E2E_MASK_BOUNDS_INVALID: expected x,y,width,height, observed ${value}`);
  }
  const [x, y, width, height] = parts;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error(`FINAL_CUT_E2E_MASK_BOUNDS_INVALID: bounds must fit within 0..1, observed ${value}`);
  }
  return { mode: "rectangle", bounds: { x, y, width, height } };
}

function sameMask(left, right) {
  return left?.mode === right?.mode
    && left?.bounds?.x === right?.bounds?.x
    && left?.bounds?.y === right?.bounds?.y
    && left?.bounds?.width === right?.bounds?.width
    && left?.bounds?.height === right?.bounds?.height;
}

function summarizeOccurrence(occurrence) {
  return {
    name: occurrence.name,
    start: occurrence.start,
    duration: occurrence.duration,
    sequenceId: occurrence.sequenceId,
  };
}
