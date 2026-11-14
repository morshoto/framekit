import { readFile } from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sanitizeFillerRemovalDiagnostic, canonicalEvidenceDigest as canonicalDigest, hashCanonicalSourceMedia } from "./final-cut-evidence.mjs";
import { parseFillerApproval, previewApprovedFiller } from "./final-cut-filler-review.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const approval = parseFillerApproval(process.env);
const expectedProject = approval.projectName;
const { start, end } = approval.range;
await assertCandidate();
await execFile("bash", [join(root, ".agents/skills/verify-final-cut-native/scripts/run-headed-check.sh"), "filler-removal"], { cwd: root });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY: "1",
    FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
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
  requireCandidateAlignment(editor);

  const inspection = await callJson("skill.inspect", { skill: "filler-removal" });
  toolResults.push({ name: "skill.inspect", status: "passed" });
  if (inspection.availability?.available !== true) {
    throw new Error(`CAPABILITY_UNAVAILABLE: filler-removal Skill requirements are unmet: ${JSON.stringify(inspection.availability?.missingRequirements ?? [])}`);
  }

  const live = await callJson("editor.live.inspect");
  toolResults.push({ name: "editor.live.inspect", status: "passed" });
  const before = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  if (before.projectName !== expectedProject || before.projectId !== approval.projectId
    || before.timeline.id !== approval.sequenceId || before.revision.id !== approval.revisionId) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${before.projectName ?? "unknown"}`);
  }
  if (live.project?.id !== before.projectId || live.sequence?.id !== before.timeline.id) {
    throw new Error("FINAL_CUT_E2E_TARGET_MISMATCH: live state and canonical snapshot identify different targets");
  }
  if (end > before.timeline.duration) {
    throw new Error(`FINAL_CUT_E2E_RANGE_MISMATCH: ${end} exceeds timeline duration ${before.timeline.duration}`);
  }

  const sourceHashesBefore = await hashCanonicalSourceMedia(before);
  const preview = await previewApprovedFiller(callJson, () => callJson("project.inspect"), before, approval);
  toolResults.push({ name: "skill.preview", status: "passed" }, { name: "skill.preview", status: "passed" });
  const candidates = preview.plan.details.candidates;
  const occurrenceId = approval.occurrenceId;
  await assertCandidate();
  requireCandidateAlignment(await callJson("editor.inspect"));

  const transaction = await callJson("skill.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "skill.execute", status: transaction.status });
  transactionId = transaction.transactionIds?.[0];
  if (transaction.status !== "VERIFIED" || !transactionId) {
    throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: filler removal was not verified");
  }
  canUndo = true;
  const continuity = transaction.verification?.checks?.find((check) => check.name === "filler-speech-continuity");
  if (!continuity?.passed) {
    throw new Error("FINAL_CUT_E2E_CONTINUITY_FAILED: filler removal did not preserve adjacent speech");
  }
  if (!(transaction.diff?.durationDelta < 0)) {
    throw new Error("FINAL_CUT_E2E_DIFF_FAILED: verified filler removal did not shorten the timeline");
  }
  const after = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });

  const sourceHashesAfter = await hashCanonicalSourceMedia(after);
  const restored = await callJson("edit.undo", { transactionId });
  toolResults.push({ name: "edit.undo", status: "passed" });
  canUndo = false;
  transactionId = undefined;
  const beforeDigest = canonicalDigest(before);
  const restoredDigest = canonicalDigest(restored);
  if (beforeDigest !== restoredDigest) {
    throw new Error("FINAL_CUT_E2E_ROLLBACK_DIGEST_MISMATCH: undo did not restore the pre-edit canonical digest");
  }

  const sourceHashesRestored = await hashCanonicalSourceMedia(restored);
  if (JSON.stringify(sourceHashesBefore) !== JSON.stringify(sourceHashesAfter)
    || JSON.stringify(sourceHashesBefore) !== JSON.stringify(sourceHashesRestored)) {
    throw new Error("FINAL_CUT_E2E_SOURCE_CHANGED: source bytes changed during the diagnostic");
  }

  const rawEvidence = {
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
      occurrenceId,
    },
    selection: { start, end },
    toolResults,
    removal: {
      status: transaction.status,
      candidateCount: candidates.length,
      operationCount: preview.plan.operations.length,
      beforeRevision: summarizeRevision(before.revision),
      afterRevision: summarizeRevision(after.revision),
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
  // This single-case diagnostic cannot supply the complete acceptance suite or
  // independently observed edited-output speech. Never emit release PASS here.
  const evidence = sanitizeFillerRemovalDiagnostic(rawEvidence, rawEvidence.environment);
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
  for (const key of ["projectRead", "timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback", "compositeTransactions", "liveStateRead", "projectCatalogRead", "projectSelection"]) {
    if (editor.capabilities.editor[key] !== true) throw new Error(`CAPABILITY_UNAVAILABLE: headed filler removal requires ${key}`);
  }
  if (editor.capabilities.analyzers?.speechTranscribe !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed filler removal requires speech transcription");
  }
  if (editor.capabilities.analyzers?.speechVad !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed filler removal requires speech VAD");
  }
  if (editor.capabilities.editor.semanticOperations?.["ripple-delete"] !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed filler removal requires ripple-delete");
  }
}

function allowlistedCapabilities(capabilities) {
  return {
    editor: {
      ...pick(capabilities.editor, ["canonicalTimelineMode", "projectRead", "timelineSnapshotRead", "timelineWrite", "timelineArtifactWrite", "readAfterWrite", "incrementalChanges", "rollback", "compositeTransactions", "assetDiscovery", "liveStateRead", "playheadWrite", "frameCapture", "projectCatalogRead", "projectSelection"]),
      semanticOperations: pick(capabilities.editor?.semanticOperations, ["ripple-delete"]),
    },
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

async function assertCandidate() {
  const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const dirty = (await execFile("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
  if (head !== approval.candidateCommit || dirty) throw new Error("FINAL_CUT_E2E_CANDIDATE_MISMATCH: checkout must be clean and match the approved candidate");
}

function requireCandidateAlignment(editor) {
  if (editor.preflight?.fingerprint?.commit !== approval.candidateCommit
    || editor.preflight?.buildAlignment?.status !== "matched" || editor.preflight?.nativeHandoffReadiness?.status !== "ready") {
    throw new Error("FINAL_CUT_E2E_PREFLIGHT_UNAVAILABLE: loaded candidate or native handoff readiness differs");
  }
}
