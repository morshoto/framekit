import { execFile as execFileCallback } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalEvidenceDigest, evidenceEnvironment, hashCanonicalSourceMedia, sanitizeDialogueNormalizationDiagnostic } from "./final-cut-evidence.mjs";
import { parseDialogueApproval, previewApprovedDialogue, requireDialogueCapabilities } from "./final-cut-dialogue-review.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
// Direct invocation must enforce consent before transport creation or native preflight.
const approval = parseDialogueApproval(process.env);
await requireCandidate();
await execFile("bash", [join(root, ".agents/skills/verify-final-cut-native/scripts/run-headed-check.sh"), "dialogue-normalization"], { cwd: root });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: { ...process.env, FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FCPXML_PATH: "",
    FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY: "1", FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1", FRAMEKIT_FINAL_CUT_HEADLESS: "0" },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-dialogue-normalization-headed-e2e", version: "0.1.0" });
let transactionId;
let canUndo = false;
let baseline;
let baselineHashes;
try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const toolResults = [{ name: "editor.inspect", status: "passed" }];
  requireLoadedCandidate(editor);
  const inspection = await callJson("skill.inspect", { skill: "dialogue-normalization" });
  toolResults.push({ name: "skill.inspect", status: "passed" });
  if (inspection.availability?.available !== true) throw new Error("CAPABILITY_UNAVAILABLE: dialogue-normalization requirements are unmet");
  const before = await readTarget();
  baseline = before;
  const sourceBefore = await hashCanonicalSourceMedia(before);
  baselineHashes = sourceBefore;
  if (before.revision.id !== approval.revisionId || canonicalEvidenceDigest(before) !== approval.baselineDigest
    || !sourceBefore.some(item => `sha256:${item.sha256}` === approval.sourceDigest)) throw new Error("DIALOGUE_REVIEW_REJECTED: approved source or baseline differs");
  // previewApprovedDialogue calls skill.preview and verifies non-mutation, signal binding and exact approved gain.
  const preview = await previewApprovedDialogue(callJson, readTarget, before, approval);
  toolResults.push({ name: "skill.preview", status: "passed" });
  await requireCandidate();
  requireLoadedCandidate(await callJson("editor.inspect"));
  const current = await readTarget();
  if (!isDeepStrictEqual(current.revision, before.revision) || canonicalEvidenceDigest(current) !== approval.baselineDigest
    || Date.parse(preview.expiresAt) <= Date.now()) throw new Error("STALE_CONTEXT: target changed before execution");
  const execution = await callJson("skill.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "skill.execute", status: execution.status });
  transactionId = execution.transactionIds?.[0];
  // Arm restoration immediately after a committed transaction, before inspecting its signal checks.
  if (execution.status === "VERIFIED" && transactionId) canUndo = true;
  if (execution.status !== "VERIFIED" || execution.transactionIds?.length !== 1) throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: normalization did not commit one verified transaction");
  const loudness = requirePassedCheck(execution, "dialogue-loudness");
  const peak = requirePassedCheck(execution, "dialogue-true-peak");
  const measurement = requirePassedCheck(execution, "dialogue-measurement").observed;
  if (loudness.observed?.integratedLufs !== measurement?.integratedLufs || peak.observed?.truePeakDb !== measurement?.truePeakDb) throw new Error("DIALOGUE_REVIEW_REJECTED: verification summaries disagree with measured output");
  const after = await readTarget();
  const sourceAfter = await hashCanonicalSourceMedia(after);
  await callJson("edit.undo", { transactionId });
  // A completed Undo must never be replayed if subsequent readback fails.
  canUndo = false;
  transactionId = undefined;
  toolResults.push({ name: "edit.undo", status: "passed" });
  const restored = await readTarget();
  const sourceRestored = await hashCanonicalSourceMedia(restored);
  const evidence = sanitizeDialogueNormalizationDiagnostic({ approval, before, after, restored, preview, measurement, execution,
    editor: editor.identity, capabilities: editor.capabilities, toolResults,
    sourceIntegrity: { before: sourceBefore, after: sourceAfter, restored: sourceRestored },
    recordedAt: new Date().toISOString() }, await evidenceEnvironment(root));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  if (canUndo && transactionId) {
    try {
      await callJson("edit.undo", { transactionId });
      canUndo = false;
      const restored = await readTarget();
      if (canonicalEvidenceDigest(restored) !== canonicalEvidenceDigest(baseline)
        || !isDeepStrictEqual(await hashCanonicalSourceMedia(restored), baselineHashes)) {
        throw new Error("RECOVERY_REQUIRED: compensating Undo did not restore baseline/source integrity");
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Dialogue diagnostic failed; recovery requires inspection, do not retry mutation");
    }
  }
  throw error;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function requireCandidate() {
  const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const dirty = (await execFile("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
  if (head !== approval.candidateCommit || dirty) throw new Error("FINAL_CUT_E2E_CANDIDATE_MISMATCH: checkout must be clean and match the approved candidate");
}
function requireLoadedCandidate(editor) {
  requireDialogueCapabilities(editor);
  if (editor.preflight?.fingerprint?.commit !== approval.candidateCommit || editor.preflight?.buildAlignment?.status !== "matched"
    || editor.preflight?.nativeHandoffReadiness?.status !== "ready") throw new Error("FINAL_CUT_E2E_PREFLIGHT_UNAVAILABLE: loaded candidate or native handoff readiness differs");
}
async function readTarget() {
  const live = await callJson("editor.live.inspect");
  const snapshot = await callJson("project.inspect");
  if (snapshot.projectId !== approval.projectId || snapshot.projectName !== approval.projectName || snapshot.timeline?.id !== approval.sequenceId
    || live.project?.id !== approval.projectId || live.sequence?.id !== approval.sequenceId) throw new Error("FINAL_CUT_E2E_TARGET_MISMATCH: active canonical target differs");
  return snapshot;
}
async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find(item => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try { return JSON.parse(text); } catch { throw new Error(`${name} returned invalid JSON`); }
}
function requirePassedCheck(execution, name) {
  const checks = execution.verification?.checks?.filter(candidate => candidate.name === name);
  if (execution.verification?.passed !== true || checks?.length !== 1 || checks[0].passed !== true) throw new Error(`FINAL_CUT_E2E_VERIFICATION_FAILED: ${name}`);
  return checks[0];
}
