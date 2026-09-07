import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceEnvironment } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const beforeQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_BEFORE_QUERY;
const afterQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_AFTER_QUERY;
const transitionQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_TRANSITION_QUERY;
const duration = parseDuration(process.env.FRAMEKIT_FINAL_CUT_E2E_TRANSITION_DURATION ?? "1/1");

if (!expectedProject || !beforeQuery || !afterQuery || !transitionQuery) {
  throw new Error(
    "Set FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_BEFORE_QUERY, FRAMEKIT_FINAL_CUT_E2E_AFTER_QUERY, and FRAMEKIT_FINAL_CUT_E2E_TRANSITION_QUERY before running the native transition headed E2E",
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
const client = new Client({ name: "framekit-transition-headed-e2e", version: "0.1.0" });
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

  const transitions = await callJson("editor.native.transition.search", { query: transitionQuery });
  toolResults.push({ name: "editor.native.transition.search", status: "passed" });
  if (!Array.isArray(transitions) || transitions.length !== 1) {
    throw new Error(`FINAL_CUT_E2E_TRANSITION_AMBIGUOUS: expected one transition result, observed ${transitions?.length ?? 0}`);
  }
  const transition = transitions[0];

  const beforeMedia = await uniqueMedia(beforeQuery, toolResults);
  const afterMedia = await uniqueMedia(afterQuery, toolResults);
  const beforeOccurrence = await uniqueOccurrence(beforeMedia.handle, "before", toolResults);
  const afterOccurrence = await uniqueOccurrence(afterMedia.handle, "after", toolResults);

  const preview = await callJson("editor.native.transition.add.preview", {
    assetId: transition.id,
    beforeOccurrenceHandle: beforeOccurrence.handle,
    afterOccurrenceHandle: afterOccurrence.handle,
    duration,
  });
  toolResults.push({ name: "editor.native.transition.add.preview", status: "passed" });
  if (preview.asset?.identity !== transition.identity
    || !preview.beforeOccurrence?.start
    || !preview.beforeOccurrence?.duration
    || !preview.afterOccurrence?.start
    || !preview.afterOccurrence?.duration
    || !preview.editPoint
    || preview.revision === undefined) {
    throw new Error("FINAL_CUT_E2E_TRANSITION_PREVIEW_FAILED: preview did not return stable identity, exact ranges, edit point, and revision");
  }

  const executed = await callJson("editor.native.transition.add.execute", { previewToken: preview.previewToken });
  operationId = executed.operationId;
  toolResults.push({ name: "editor.native.transition.add.execute", status: executed.verification?.verified ? "passed" : "failed" });
  if (!executed.verification?.verified
    || !executed.undoAvailable
    || !executed.undoCommand
    || !executed.observedDuration
    || compareRational(executed.observedDuration, duration) !== 0n
    || executed.beforeRevision?.id === executed.afterRevision?.id) {
    throw new Error("FINAL_CUT_E2E_TRANSITION_EXECUTE_FAILED: native transition placement was not verified with observed duration and a new revision");
  }
  const undone = await callJson("editor.native.undo", { operationId });
  toolResults.push({ name: "editor.native.undo", status: undone.verification?.verified ? "passed" : "failed" });
  if (!undone.undone || !undone.verification?.verified) {
    throw new Error("FINAL_CUT_E2E_TRANSITION_UNDO_FAILED: native Undo did not verify restoration");
  }
  operationId = undefined;

  const environment = await evidenceEnvironment(root);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceType: "headed-native-transition-placement",
    passed: true,
    recordedAt: new Date().toISOString(),
    environment,
    project: expectedProject,
    transition: {
      id: transition.id,
      name: transition.name,
      identity: transition.identity,
    },
    occurrences: {
      before: summarizeOccurrence(preview.beforeOccurrence),
      after: summarizeOccurrence(preview.afterOccurrence),
    },
    editPoint: preview.editPoint,
    requestedDuration: duration,
    observedDuration: executed.observedDuration,
    revisions: {
      before: executed.beforeRevision.id,
      after: executed.afterRevision.id,
      restored: undone.context?.revision?.id,
    },
    undo: { available: true, command: executed.undoCommand, verified: true },
    toolResults,
  }, null, 2)}\n`);
} catch (error) {
  if (operationId) {
    try {
      await callJson("editor.native.undo", { operationId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Native transition headed E2E failed and compensating Undo also failed");
    }
  }
  throw error;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function uniqueMedia(query, toolResults) {
  let matches = await callJson("editor.native.media.search", { query });
  if (Array.isArray(matches) && matches.length === 0) {
    matches = await callJson("editor.native.media.search", { query });
  }
  toolResults.push({ name: "editor.native.media.search", status: "passed" });
  if (!Array.isArray(matches) || matches.length !== 1) {
    throw new Error(`FINAL_CUT_E2E_MEDIA_AMBIGUOUS: query ${query} returned ${matches?.length ?? 0} matches`);
  }
  return matches[0];
}

async function uniqueOccurrence(mediaHandle, label, toolResults) {
  const located = await callJson("editor.native.timeline.locate", { mediaHandle });
  toolResults.push({ name: "editor.native.timeline.locate", status: "passed" });
  if (located.status !== "unique" || !Array.isArray(located.occurrences) || located.occurrences.length !== 1) {
    throw new Error(`FINAL_CUT_E2E_OCCURRENCE_${label.toUpperCase()}_AMBIGUOUS: expected one occurrence`);
  }
  return located.occurrences[0];
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

function parseDuration(value) {
  const match = value.match(/^(-?\d+)\/(\d+)$/);
  if (!match || match[2] === "0" || BigInt(match[1]) <= 0n) {
    throw new Error(`FINAL_CUT_E2E_DURATION_INVALID: expected a positive rational value/timescale, observed ${value}`);
  }
  return { value: match[1], timescale: match[2] };
}

function compareRational(left, right) {
  return BigInt(left.value) * BigInt(right.timescale) - BigInt(right.value) * BigInt(left.timescale);
}

function summarizeOccurrence(occurrence) {
  return {
    name: occurrence.name,
    start: occurrence.start,
    duration: occurrence.duration,
    sequenceId: occurrence.sequenceId,
  };
}
