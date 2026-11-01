import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { selectCanonicalWriteTarget, readCanonicalWriteTarget } from "./final-cut-canonical-write-target.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalEvidenceDigest as canonicalDigest, evidenceEnvironment, hashCanonicalSourceMedia, sanitizeCanonicalEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const clipId = process.env.FRAMEKIT_FINAL_CUT_E2E_CLIP_ID;
const approvedTarget = { projectId: process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID, projectName: expectedProject, sequenceId: process.env.FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID };
const approvedRevision = process.env.FRAMEKIT_FINAL_CUT_E2E_REVISION_ID;
const candidateCommit = process.env.FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT;

if (!expectedProject || !clipId) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_CLIP_ID before running the canonical headed E2E");
}

if (!approvedTarget.projectId || !approvedTarget.sequenceId || !approvedRevision || !/^[a-f0-9]{40}$/.test(candidateCommit ?? "") || process.env.FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION !== "1") {
  throw new Error("FINAL_CUT_E2E_AUTHORIZATION_REQUIRED: provide the approved project, sequence, revision, candidate commit, and mutation authorization");
}
const execFile = promisify(execFileCallback);
const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const dirty = (await execFile("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
if (head !== candidateCommit || dirty) throw new Error("FINAL_CUT_E2E_CANDIDATE_MISMATCH: checkout must be clean and match the approved candidate");
await execFile("bash", [join(root, ".agents/skills/verify-final-cut-native/scripts/run-headed-check.sh"), "canonical-write"], { cwd: root });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
    FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-canonical-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const preflight = await callJson("editor.inspect");
  const toolResults = [{ name: "editor.inspect", status: "passed" }];
  if (preflight.preflight?.fingerprint?.commit !== candidateCommit
    || preflight.preflight?.buildAlignment?.status !== "matched"
    || preflight.preflight?.nativeHandoffReadiness?.status !== "ready") {
    throw new Error("FINAL_CUT_E2E_PREFLIGHT_UNAVAILABLE: candidate, loaded extension, or native handoff readiness does not match");
  }
  await selectCanonicalWriteTarget(callJson, approvedTarget);
  toolResults.push({ name: "project.list", status: "passed" }, { name: "project.select", status: "passed" });
  const before = await readCanonicalWriteTarget(callJson, approvedTarget);
  toolResults.push({ name: "project.inspect", status: "passed" });
  if (before.revision?.id !== approvedRevision) throw new Error("STALE_CONTEXT: canonical baseline differs from the approved revision");
  const editor = await callJson("editor.inspect");
  toolResults.push({ name: "editor.inspect", status: "passed" });
  if (editor.capabilities?.editor?.canonicalTimelineMode !== "canonical-write"
    || editor.capabilities?.editor?.semanticOperations?.["rename-clip"] !== true
    || editor.preflight?.fingerprint?.commit !== candidateCommit
    || editor.preflight?.buildAlignment?.status !== "matched"
    || editor.preflight?.nativeHandoffReadiness?.status !== "ready") {
    throw new Error("CAPABILITY_UNAVAILABLE: canonical rename and matching native preflight are required");
  }
  const target = before.timeline?.clips?.find((clip) => clip.id === clipId);
  if (!target) throw new Error(`FINAL_CUT_E2E_CLIP_MISMATCH: ${clipId} is not in the selected timeline`);
  const beforeDigest = canonicalDigest(before);
  const sourceHashesBefore = await hashCanonicalSourceMedia(before);

  await expectToolError("editor.timeline.edit", {
    projectId: before.projectId,
    sequenceId: before.timeline.id,
    type: "rename-clip",
    clipId,
    name: `${target.name} [Stale Probe]`,
    baseRevision: { ...before.revision, id: `stale:${before.revision.id}` },
  }, "STALE_CONTEXT");
  toolResults.push({ name: "editor.timeline.edit", status: "rejected-stale-context" });
  const afterStaleProbe = await readCanonicalWriteTarget(callJson, approvedTarget);
  if (canonicalDigest(afterStaleProbe) !== beforeDigest || !sameRevision(afterStaleProbe.revision, before.revision)) {
    throw new Error("FINAL_CUT_E2E_STALE_PROBE_MUTATED: stale revision rejection changed canonical state");
  }
  toolResults.push({ name: "project.inspect", status: "unchanged" });

  await expectToolError("editor.timeline.edit", {
    projectId: "framekit:e2e:wrong-project",
    sequenceId: before.timeline.id,
    type: "rename-clip",
    clipId,
    name: `${target.name} [Target Probe]`,
    baseRevision: before.revision,
  }, "TARGET_MISMATCH");
  toolResults.push({ name: "editor.timeline.edit", status: "rejected-target-mismatch" });
  const afterTargetProbe = await readCanonicalWriteTarget(callJson, approvedTarget);
  if (canonicalDigest(afterTargetProbe) !== beforeDigest || !sameRevision(afterTargetProbe.revision, before.revision)) {
    throw new Error("FINAL_CUT_E2E_TARGET_PROBE_MUTATED: target rejection changed canonical state");
  }
  toolResults.push({ name: "project.inspect", status: "unchanged" });

  const transaction = await callJson("editor.timeline.edit", {
    projectId: before.projectId,
    sequenceId: before.timeline.id,
    type: "rename-clip",
    clipId,
    name: `${target.name} [Framekit E2E]`,
    baseRevision: before.revision,
  });
  toolResults.push({ name: "editor.timeline.edit", status: transaction.status });
  if (transaction.status !== "VERIFIED" || transaction.diff?.modified?.[0]?.itemId !== clipId) {
    throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: live edit did not return the expected verified diff");
  }

  const restored = await callJson("edit.undo", { transactionId: transaction.id });
  toolResults.push({ name: "edit.undo", status: "passed" });
  const restoredDigest = canonicalDigest(restored);
  if (restoredDigest !== beforeDigest) {
    throw new Error("FINAL_CUT_E2E_ROLLBACK_DIGEST_MISMATCH: undo did not restore the pre-edit canonical digest");
  }
  const sourceHashesRestored = await hashCanonicalSourceMedia(restored);

  const evidence = sanitizeCanonicalEvidence({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    project: { id: before.projectId, name: before.projectName, sequenceId: before.timeline.id },
    target: { occurrenceId: target.id, mediaId: target.mediaId },
    toolResults,
    editStatus: transaction.status,
    before,
    after: transaction.after,
    diff: transaction.diff,
    restored,
    digests: { before: beforeDigest, restored: restoredDigest },
    sourceIntegrity: { before: sourceHashesBefore, restored: sourceHashesRestored },
  }, await evidenceEnvironment(root));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
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

async function expectToolError(name, arguments_, expectedCode) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded`);
  if (!text.includes(expectedCode)) {
    throw new Error(`${name} returned the wrong failure code; expected ${expectedCode}`);
  }
}

function sameRevision(left, right) {
  return left?.id === right?.id
    && left?.sequence === right?.sequence
    && left?.timestamp === right?.timestamp;
}
