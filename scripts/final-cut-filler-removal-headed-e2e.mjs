import { readFile } from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const start = Number(process.env.FRAMEKIT_FINAL_CUT_E2E_RANGE_START);
const end = Number(process.env.FRAMEKIT_FINAL_CUT_E2E_RANGE_END);

if (!expectedProject) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT before running the filler-removal headed E2E");
}
if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_RANGE_START and FRAMEKIT_FINAL_CUT_E2E_RANGE_END to a positive timeline range");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-filler-removal-headed-e2e", version: "0.1.0" });
let transactionId;
let canUndo = false;

try {
  await client.connect(transport);
  const toolResults = [];
  const editor = await callJson("editor.inspect");
  toolResults.push({ name: "editor.inspect", status: "passed" });
  requireCanonicalWrite(editor);

  const live = await callJson("editor.live.inspect");
  toolResults.push({ name: "editor.live.inspect", status: "passed" });
  const before = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  if (before.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${before.projectName ?? "unknown"}`);
  }
  if (live.project?.id !== before.projectId || live.sequence?.id !== before.timeline.id) {
    throw new Error("FINAL_CUT_E2E_TARGET_MISMATCH: live state and canonical snapshot identify different targets");
  }
  if (end > before.timeline.duration) {
    throw new Error(`FINAL_CUT_E2E_RANGE_MISMATCH: ${end} exceeds timeline duration ${before.timeline.duration}`);
  }

  const preview = await callJson("speech.filler.remove.preview", {
    baseRevision: before.revision,
    range: { start, end },
  });
  toolResults.push({ name: "speech.filler.remove.preview", status: "passed" });
  if (!Array.isArray(preview.candidates) || preview.candidates.length === 0) {
    throw new Error("FINAL_CUT_E2E_NO_FILLERS: the disposable range contains no high-confidence fillers");
  }

  const transaction = await callJson("speech.filler.remove.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "speech.filler.remove.execute", status: transaction.status });
  transactionId = transaction.id;
  if (transaction.status !== "VERIFIED") {
    throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: filler removal was not verified");
  }
  const continuity = transaction.verification?.checks?.find((check) => check.name === "filler-speech-continuity");
  if (!continuity?.passed) {
    throw new Error("FINAL_CUT_E2E_CONTINUITY_FAILED: filler removal did not preserve adjacent speech");
  }
  if (!(transaction.diff?.durationDelta < 0)) {
    throw new Error("FINAL_CUT_E2E_DIFF_FAILED: verified filler removal did not shorten the timeline");
  }
  canUndo = true;

  const restored = await callJson("edit.undo", { transactionId });
  toolResults.push({ name: "edit.undo", status: "passed" });
  canUndo = false;
  transactionId = undefined;
  const beforeDigest = canonicalDigest(before);
  const restoredDigest = canonicalDigest(restored);
  if (beforeDigest !== restoredDigest) {
    throw new Error("FINAL_CUT_E2E_ROLLBACK_DIGEST_MISMATCH: undo did not restore the pre-edit canonical digest");
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: "headed-native-filler-removal",
    passed: true,
    recordedAt: new Date().toISOString(),
    environment: await evidenceEnvironment(),
    editor: {
      name: editor.identity.name,
      version: editor.identity.version,
      backend: editor.identity.backend,
    },
    capabilities: allowlistedCapabilities(editor.capabilities),
    project: {
      id: before.projectId,
      name: before.projectName,
      sequenceId: before.timeline.id,
    },
    selection: { start, end },
    toolResults,
    removal: {
      status: transaction.status,
      candidateCount: preview.candidates.length,
      operationCount: transaction.applied.length,
      beforeRevision: summarizeRevision(before.revision),
      afterRevision: summarizeRevision(transaction.after.revision),
      removedDurationSeconds: -transaction.diff.durationDelta,
      affectedRangeCount: transaction.diff.affectedRanges.length,
      continuityVerified: true,
    },
    restoration: {
      operation: "edit.undo",
      status: "VERIFIED",
      restored: true,
      beforeDigest,
      restoredDigest,
      restoredRevision: summarizeRevision(restored.revision),
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  if (canUndo && transactionId) {
    try {
      await callJson("edit.undo", { transactionId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Filler-removal headed E2E failed and compensating undo also failed");
    }
  }
  throw error;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${text}`);
  }
}

function requireCanonicalWrite(editor) {
  if (editor.capabilities?.editor?.canonicalTimelineMode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${editor.capabilities?.editor?.canonicalTimelineMode ?? "unknown"}; canonical-write is required`);
  }
  for (const key of ["projectRead", "timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback", "liveStateRead", "projectCatalogRead", "projectSelection"]) {
    if (editor.capabilities.editor[key] !== true) throw new Error(`CAPABILITY_UNAVAILABLE: headed filler removal requires ${key}`);
  }
  if (editor.capabilities.analyzers?.speechTranscribe !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed filler removal requires speech transcription");
  }
}

function allowlistedCapabilities(capabilities) {
  return {
    editor: pick(capabilities.editor, ["canonicalTimelineMode", "projectRead", "timelineSnapshotRead", "timelineWrite", "timelineArtifactWrite", "readAfterWrite", "incrementalChanges", "rollback", "assetDiscovery", "liveStateRead", "playheadWrite", "frameCapture", "projectCatalogRead", "projectSelection"]),
    analyzers: pick(capabilities.analyzers, ["speechTranscribe", "speechVad", "audioLoudness", "visualTrack"]),
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function summarizeRevision(revision) {
  return { id: revision.id, sequence: revision.sequence, timestamp: revision.timestamp };
}

async function evidenceEnvironment() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const gitCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) throw new Error("FINAL_CUT_E2E_COMMIT_UNAVAILABLE: git did not return a full commit");
  return {
    framekitVersion: packageJson.version,
    finalCutVersion: (await execFile("osascript", ["-e", 'tell application "Final Cut Pro" to get version'])).stdout.trim(),
    gitCommit,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
}

function canonicalDigest(snapshot) {
  return createHash("sha256").update(stableJson({
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    timeline: snapshot.timeline,
    media: snapshot.media.map(({ mediaId, source }) => ({ mediaId, source })),
  })).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
