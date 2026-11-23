import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindQaAuthorization, claimDispatchIntent, createOrInspectRun, inspectRun, markDispatchUncertain } from "../../../scripts/native-qa/run-store.js";
import { runPublishStages } from "../../../scripts/final-cut-publisher-verification.mjs";
import { readQaEvidence, resumeHeadlessQaRun } from "../../../scripts/native-qa/supervisor.js";
import { publishQaRecord } from "../../../scripts/native-qa/atomic-record.js";
import { readQaArtifactEvidence, verifyQaArtifact } from "../../../scripts/native-qa/artifact-evidence.js";

const manifest = {
  qaRunId: "qa-fixture-1", candidateCommit: "a".repeat(40), candidateTree: "b".repeat(40),
  packageDigest: "1".repeat(64), mcpDigest: "8".repeat(64), pluginDigest: "2".repeat(64), extensionDigest: "3".repeat(64),
  artifactDigest: "4".repeat(64), sourceDigest: "5".repeat(64), targetDigest: "6".repeat(64),
  operation: "rough-cut-publish" as const, authorizationDigest: "7".repeat(64),
};

test("initial creation and identical restart are inspect-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    const first = await createOrInspectRun(root, manifest);
    assert.equal(first.created, true);
    assert.equal(first.run.dispatch, "NOT_DISPATCHED");
    assert.equal(first.run.verdict, "BLOCKED");
    const second = await createOrInspectRun(root, manifest);
    assert.equal(second.created, false);
    assert.deepEqual(second.run, first.run);
    assert.deepEqual(await inspectRun(root, manifest.qaRunId), first.run);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed candidate, target or authorization is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    await createOrInspectRun(root, manifest);
    for (const changed of [{ candidateCommit: "c".repeat(40) }, { targetDigest: "8".repeat(64) }, { mcpDigest: "9".repeat(64) }, { authorizationDigest: "9".repeat(64) }]) {
      await assert.rejects(createOrInspectRun(root, { ...manifest, ...changed }), /QA_RUN_IDENTITY_MISMATCH/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt state and invalid run identifiers fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "../other" }), /QA_RUN_ID_INVALID/);
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "run.json"), "{");
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_CORRUPT/);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent identical starts create at most one record", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-race-"));
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => createOrInspectRun(root, manifest)));
    const created = attempts.filter(result => result.status === "fulfilled" && result.value.created);
    assert.equal(created.length, 1);
    for (const result of attempts) {
      if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
      else assert.equal(result.value.run.dispatch, "NOT_DISPATCHED");
    }
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete initialization is never treated as a new run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-incomplete-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, manifest.qaRunId));
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("linked run directories cannot masquerade as owned records", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-link-"));
  const other = await mkdtemp(join(tmpdir(), "framekit-qa-other-"));
  try {
    await createOrInspectRun(other, manifest);
    await symlink(join(other, manifest.qaRunId), join(root, manifest.qaRunId), "dir");
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_UNSAFE_PATH/);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_UNSAFE_PATH/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});


test("uncertain dispatch remains blocked across repeated starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-uncertain-"));
  try {
    await createOrInspectRun(root, manifest);
    const marked = await markDispatchUncertain(root, manifest);
    assert.equal(marked.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(marked.verdict, "BLOCKED");
    assert.deepEqual(await markDispatchUncertain(root, manifest), marked);
    const reopened = await createOrInspectRun(root, manifest);
    assert.equal(reopened.created, false);
    assert.deepEqual(reopened.run, marked);
    await assert.rejects(markDispatchUncertain(root, { ...manifest, targetDigest: "8".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an incomplete dispatch marker is never interpreted as safe to replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-marker-"));
  try {
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "dispatch-uncertain"), "");
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mismatched identity cannot mark an existing run uncertain", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mismatch-"));
  try {
    await createOrInspectRun(root, manifest);
    await assert.rejects(markDispatchUncertain(root, { ...manifest, sourceDigest: "8".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent uncertainty records converge without enabling dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mark-race-"));
  try {
    await createOrInspectRun(root, manifest);
    const observations = await Promise.all(Array.from({ length: 8 }, () => markDispatchUncertain(root, manifest)));
    assert.ok(observations.every(run => run.dispatch === "UNKNOWN_AFTER_DISPATCH" && run.verdict === "BLOCKED"));
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creation binds the input snapshot before asynchronous work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-input-race-"));
  try {
    const supplied = { ...manifest };
    const pending = createOrInspectRun(root, supplied);
    supplied.targetDigest = "8".repeat(64);
    const result = await pending;
    assert.equal(result.run.manifest.targetDigest, manifest.targetDigest);
    assert.equal((await inspectRun(root, manifest.qaRunId)).manifest.targetDigest, manifest.targetDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncertainty recording binds the input snapshot before asynchronous work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mark-input-"));
  try {
    await createOrInspectRun(root, manifest);
    const supplied = { ...manifest };
    const pending = markDispatchUncertain(root, supplied);
    supplied.authorizationDigest = "9".repeat(64);
    assert.equal((await pending).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("uncertain state survives a separate process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-process-"));
  try {
    const script = `import { createOrInspectRun, markDispatchUncertain } from "./scripts/native-qa/run-store.ts";
      let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
      const manifest = JSON.parse(text); await createOrInspectRun(process.argv[1], manifest); await markDispatchUncertain(process.argv[1], manifest);`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { input: JSON.stringify(manifest), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("dispatch intent binds a publisher job before any receiver call", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-"));
  try {
    await createOrInspectRun(root, manifest);
    const intent = await claimDispatchIntent(root, manifest, "publish-job-123");
    assert.equal(intent.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(intent.publishJobId, "publish-job-123");
    assert.equal((await inspectRun(root, manifest.qaRunId)).publishJobId, "publish-job-123");
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-123"), /QA_DISPATCH_ALREADY_CLAIMED/);
    await assert.rejects(claimDispatchIntent(root, manifest, "different-job"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("competing dispatch intent claims have at most one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-race-"));
  try {
    await createOrInspectRun(root, manifest);
    const claims = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => claimDispatchIntent(root, manifest, `job-${i}`)));
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(claims.filter(result => result.status === "rejected").every(result => /QA_DISPATCH_ALREADY_CLAIMED/.test(String(result.reason))));
    assert.match((await inspectRun(root, manifest.qaRunId)).publishJobId ?? "", /^job-[0-7]$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid job identity and stale authorization cannot claim dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-invalid-"));
  try {
    await createOrInspectRun(root, manifest);
    await assert.rejects(claimDispatchIntent(root, manifest, "../secret"), /QA_PUBLISH_JOB_ID_INVALID/);
    await assert.rejects(claimDispatchIntent(root, { ...manifest, authorizationDigest: "9".repeat(64) }, "job-1"), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("simulated lost acknowledgement retains the publisher job and prevents redispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publisher-"));
  try {
    await createOrInspectRun(root, manifest);
    let deliveries = 0;
    const call = async (name: string) => {
      if (name === "artifact.publish.preview") return { jobId: "publish-job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/new.fcpbundle" };
      deliveries++;
      const observed = await inspectRun(root, manifest.qaRunId);
      assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
      assert.equal(observed.publishJobId, "publish-job-123");
      throw new Error("simulated acknowledgement loss");
    };
    const input = { artifactPath: "/fixture/source.fcpxml", transactionId: "fixture-1", targetLibraryPath: "/fixture/new.fcpbundle", artifactDigest: manifest.artifactDigest };
    const beforeDispatch = async (jobId: string) => { await claimDispatchIntent(root, manifest, jobId); };
    await assert.rejects(runPublishStages(call, input, () => {}, beforeDispatch), /PUBLISH_DISPATCH_UNCERTAIN/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).publishJobId, "publish-job-123");
    await assert.rejects(runPublishStages(call, input, () => {}, beforeDispatch), /QA_DISPATCH_ALREADY_CLAIMED/);
    assert.equal(deliveries, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher job identity survives a separate process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-job-process-"));
  try {
    const script = `import { createOrInspectRun, claimDispatchIntent } from "./scripts/native-qa/run-store.ts";
      let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
      const manifest = JSON.parse(text); await createOrInspectRun(process.argv[1], manifest); await claimDispatchIntent(process.argv[1], manifest, "publish-job-fixture");`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { input: JSON.stringify(manifest), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.publishJobId, "publish-job-fixture");
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-fixture"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a separate run cannot reuse an operation authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-"));
  try {
    await createOrInspectRun(root, manifest);
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "another-run" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, manifest.qaRunId);
    assert.equal((await createOrInspectRun(root, { ...manifest, qaRunId: "another-run" })).run.manifest.qaRunId, manifest.qaRunId);
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "changed-run", targetDigest: "9".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
    const separate = await createOrInspectRun(root, { ...manifest, qaRunId: "separate-run", targetDigest: "b".repeat(64), authorizationDigest: "a".repeat(64) });
    assert.equal(separate.created, true);
    assert.equal(separate.run.verdict, "BLOCKED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent different run IDs cannot consume the same authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-race-"));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createOrInspectRun(root, { ...manifest, qaRunId: `run-${i}` })));
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.created).length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => /QA_RUN_NOT_FOUND_OR_INCOMPLETE/.test(String(result.reason))));
    const owner = results.find(result => result.status === "fulfilled" && result.value.created);
    assert.ok(owner && owner.status === "fulfilled");
    for (let i = 0; i < 8; i++) {
      const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: `run-${i}` });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.run.manifest.qaRunId, owner.value.run.manifest.qaRunId);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing authorization binding cannot claim a dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-missing-"));
  try {
    await createOrInspectRun(root, manifest);
    await rm(join(root, `.authorization-${manifest.authorizationDigest}`), { recursive: true });
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-1"), /QA_AUTHORIZATION_BINDING_INVALID/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("QA records require a private, owned root and private directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-private-"));
  try {
    await chmod(root, 0o777);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_ROOT_UNSAFE/);
    await chmod(root, 0o700);
    await createOrInspectRun(root, manifest);
    assert.equal((await lstat(join(root, manifest.qaRunId))).mode & 0o077, 0);
    assert.equal((await lstat(join(root, `.authorization-${manifest.authorizationDigest}`))).mode & 0o077, 0);
    await chmod(root, 0o755);
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_ROOT_UNSAFE/);
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-1"), /QA_RUN_ROOT_UNSAFE/);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});

test("a symbolic link cannot be used as the QA root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "framekit-qa-root-link-"));
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-real-root-"));
  try {
    const link = join(parent, "link");
    await symlink(root, link, "dir");
    await assert.rejects(createOrInspectRun(link, manifest), /QA_RUN_ROOT_UNSAFE/);
  } finally { await rm(parent, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test("duplicate authorization returns the original uncertain job for inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-duplicate-unknown-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "replacement-run" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, manifest.qaRunId);
    assert.equal(duplicate.run.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(duplicate.run.publishJobId, "publish-job-1");
    assert.equal(duplicate.run.verdict, "BLOCKED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an incomplete authorization binding never creates another run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-incomplete-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, `.authorization-${manifest.authorizationDigest}`));
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "other-run" }), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("detached headless preflight persists evidence after the client exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-supervisor-"));
  const manifestPath = join(root, "manifest.json");
  const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
  try {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, authorizationDigest: null }));
    const start = spawnSync(process.execPath, [...cli, "start", root, manifestPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(start.status, 0, start.stderr);
    const created = JSON.parse(start.stdout);
    assert.equal(created.created, true);
    assert.equal(created.run.dispatch, "NOT_DISPATCHED");
    let content = "";
    for (let i = 0; i < 100; i++) {
      try { content = await readFile(join(root, manifest.qaRunId, "headless-result.json"), "utf8"); if (content.endsWith("\n")) break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(content, "detached worker did not write headless evidence");
    const evidence = spawnSync(process.execPath, [...cli, "evidence", root, manifest.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(evidence.status, 0, evidence.stderr);
    const result = JSON.parse(evidence.stdout);
    assert.equal(result.tier, "headless");
    assert.equal(result.result, "candidate-mismatch");
    assert.equal(result.verdict, "BLOCKED");
    assert.equal(result.dispatch, "NOT_DISPATCHED");
    assert.match(result.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, qaRunId: "different-client-run", authorizationDigest: null }));
    const duplicate = spawnSync(process.execPath, [...cli, "start", root, manifestPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, false);
    assert.equal(JSON.parse(duplicate.stdout).run.manifest.qaRunId, manifest.qaRunId);
    await assert.rejects(lstat(join(root, "different-client-run")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("missing or corrupt headless evidence never enables native work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-evidence-"));
  try {
    await createOrInspectRun(root, manifest);
    assert.deepEqual(await readQaEvidence(root, manifest.qaRunId), { tier: "headless", result: "pending-or-interrupted", verdict: "BLOCKED", dispatch: "NOT_DISPATCHED" });
    await writeFile(join(root, manifest.qaRunId, "headless-result.json"), "{");
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless evidence rejects unsanitized fields and reversed timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-evidence-invalid-"));
  try {
    await createOrInspectRun(root, manifest);
    const path = join(root, manifest.qaRunId, "headless-result.json");
    const data = { schemaVersion: 1, tier: "headless", result: "render-contract-passed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" };
    await writeFile(join(root, manifest.qaRunId, "headless-started"), JSON.stringify({ schemaVersion: 1, startedAt: data.startedAt }));
    await writeFile(path, JSON.stringify({ ...data, privatePath: "sensitive-value" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
    await writeFile(path, JSON.stringify({ ...data, finishedAt: "2025-01-01T00:00:00.000Z" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("interrupted headless work retains its original start timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-start-evidence-"));
  try {
    await createOrInspectRun(root, manifest);
    const startedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(join(root, manifest.qaRunId, "headless-started"), JSON.stringify({ schemaVersion: 1, startedAt }) + "\n");
    const pending = await readQaEvidence(root, manifest.qaRunId);
    assert.equal(pending.result, "pending-or-interrupted");
    assert.equal(pending.startedAt, startedAt);
    assert.equal(pending.verdict, "BLOCKED");
    await writeFile(join(root, manifest.qaRunId, "headless-result.json"), JSON.stringify({ schemaVersion: 1, tier: "headless", result: "render-contract-passed", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:01.000Z" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt headless start evidence stays blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-start-corrupt-"));
  try {
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "headless-started"), "{");
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("evidence publication is complete and exclusive for concurrent readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-atomic-"));
  try {
    const path = join(root, "record.json");
    const content = JSON.stringify({ value: "a".repeat(2 * 1024 * 1024) }) + "\n";
    let finished = false;
    let writingError: unknown;
    const writing = publishQaRecord(path, content).then(() => { finished = true; }, error => { writingError = error; finished = true; });
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      try { assert.equal(await readFile(path, "utf8"), content); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(finished, true, "evidence publication did not finish within five seconds");
    await writing;
    if (writingError) throw writingError;
    assert.equal(await readFile(path, "utf8"), content);
    await assert.rejects(publishQaRecord(path, "replacement"), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    assert.equal(await readFile(path, "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless preflight can start without native authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-no-approval-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    const first = await createOrInspectRun(root, unapproved);
    assert.equal(first.created, true);
    assert.equal(first.run.manifest.authorizationDigest, null);
    assert.equal((await createOrInspectRun(root, unapproved)).created, false);
    await assert.rejects(claimDispatchIntent(root, unapproved, "publish-job-1"), /QA_AUTHORIZATION_REQUIRED/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a separate authorization digest can be bound after headless preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-approval-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const digest = "9".repeat(64);
    const bound = await bindQaAuthorization(root, unapproved, digest);
    assert.equal(bound.bound, true);
    assert.equal(bound.run.manifest.authorizationDigest, null);
    assert.equal(bound.run.authorizationBinding, digest);
    assert.equal((await inspectRun(root, unapproved.qaRunId)).authorizationBinding, digest);
    assert.equal((await bindQaAuthorization(root, unapproved, digest)).bound, false);
    await assert.rejects(bindQaAuthorization(root, unapproved, "a".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await claimDispatchIntent(root, unapproved, "publish-job-1")).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authorization binding rejects changed identity and uncertain runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-identity-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await assert.rejects(bindQaAuthorization(root, { ...unapproved, targetDigest: "a".repeat(64) }, "9".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    await markDispatchUncertain(root, unapproved);
    await assert.rejects(bindQaAuthorization(root, unapproved, "9".repeat(64)), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one authorization cannot bind different target identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-target-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const other = { ...first, qaRunId: "other-run", targetDigest: "a".repeat(64) };
    await createOrInspectRun(root, first);
    await createOrInspectRun(root, other);
    await bindQaAuthorization(root, first, "9".repeat(64));
    await assert.rejects(bindQaAuthorization(root, other, "9".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    await assert.rejects(claimDispatchIntent(root, other, "publish-job-2"), /QA_AUTHORIZATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate later authorization returns the original run without a new claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-duplicate-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const second = { ...first, qaRunId: "second-run" };
    await createOrInspectRun(root, first);
    const preflight = await createOrInspectRun(root, second);
    assert.equal(preflight.created, false);
    await bindQaAuthorization(root, first, "9".repeat(64));
    const duplicate = await bindQaAuthorization(root, preflight.run.manifest, "9".repeat(64));
    assert.equal(duplicate.bound, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
    await assert.rejects(claimDispatchIntent(root, second, "publish-job-2"), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent authorization bindings have at most one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-race-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => bindQaAuthorization(root, unapproved, "9".repeat(64))));
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.bound).length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => /QA_AUTHORIZATION_BINDING_INCOMPLETE/.test(String(result.reason))));
    assert.equal((await inspectRun(root, unapproved.qaRunId)).authorizationBinding, "9".repeat(64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing bound authorization index blocks inspection and claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-missing-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await bindQaAuthorization(root, unapproved, "9".repeat(64));
    await rm(join(root, `.authorization-${"9".repeat(64)}`), { recursive: true });
    await assert.rejects(inspectRun(root, unapproved.qaRunId), /QA_RUN_CORRUPT/);
    await assert.rejects(claimDispatchIntent(root, unapproved, "publish-job-1"), /QA_RUN_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a later authorized duplicate inspects the existing preflight run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-later-duplicate-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await bindQaAuthorization(root, unapproved, "9".repeat(64));
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "later-run", authorizationDigest: "9".repeat(64) });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, unapproved.qaRunId);
    assert.equal(duplicate.run.authorizationBinding, "9".repeat(64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI records a separate digest without claiming consent or dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cli-binding-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "record-authorization", root, unapproved.qaRunId, "9".repeat(64)], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.bound, true);
    assert.equal(value.run.authorizationBinding, "9".repeat(64));
    assert.equal(value.authorizationVerified, false);
    assert.equal(value.dispatchAllowed, false);
    assert.equal(value.run.dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unapproved duplicate starts inspect the original job across run IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-preflight-duplicate-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const second = { ...first, qaRunId: "second-preflight" };
    assert.equal((await createOrInspectRun(root, first)).created, true);
    const duplicate = await createOrInspectRun(root, second);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
    const changed = { ...second, targetDigest: "a".repeat(64) };
    assert.equal((await createOrInspectRun(root, changed)).created, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("competing unapproved starts create at most one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-preflight-race-"));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createOrInspectRun(root, { ...manifest, qaRunId: `preflight-${i}`, authorizationDigest: null })));
    const created = results.filter(result => result.status === "fulfilled" && result.value.created);
    assert.equal(created.length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("an authorized start cannot bypass the existing unapproved job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cross-form-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const authorized = { ...manifest, qaRunId: "other-start", authorizationDigest: "9".repeat(64) };
    await createOrInspectRun(root, first);
    await assert.rejects(createOrInspectRun(root, authorized), /QA_RUN_IDENTITY_MISMATCH/);
    await bindQaAuthorization(root, first, "9".repeat(64));
    const duplicate = await createOrInspectRun(root, authorized);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("racing authorized and unapproved starts create at most one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cross-form-race-"));
  try {
    const unapproved = { ...manifest, qaRunId: "without-approval", authorizationDigest: null };
    const authorized = { ...manifest, qaRunId: "with-approval" };
    const results = await Promise.allSettled([createOrInspectRun(root, unapproved), createOrInspectRun(root, authorized)]);
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.created).length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE|QA_RUN_IDENTITY_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a missing job index cannot turn an uncertain run into a new job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-lost-index-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    await markDispatchUncertain(root, first);
    const indices = (await readdir(root)).filter(name => name.startsWith(".job-"));
    assert.equal(indices.length, 1);
    await rm(join(root, indices[0]!), { recursive: true });
    await assert.rejects(createOrInspectRun(root, { ...first, qaRunId: "replacement-run" }), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(root, first.qaRunId)).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown or corrupt existing runs block new job registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-corrupt-index-scan-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    await writeFile(join(root, first.qaRunId, "run.json"), "{");
    const different = { ...first, qaRunId: "another-job", targetDigest: "a".repeat(64) };
    await assert.rejects(createOrInspectRun(root, different), /QA_INDEX_RECONCILIATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing job index blocks authorization binding and dispatch claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-index-mutation-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    const index = (await readdir(root)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(root, index), { recursive: true });
    await assert.rejects(bindQaAuthorization(root, first, "9".repeat(64)), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(root, first.qaRunId)).authorizationBinding, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }

  const otherRoot = await mkdtemp(join(tmpdir(), "framekit-qa-index-claim-"));
  try {
    await createOrInspectRun(otherRoot, manifest);
    const index = (await readdir(otherRoot)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(otherRoot, index), { recursive: true });
    await assert.rejects(claimDispatchIntent(otherRoot, manifest, "publish-job-1"), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(otherRoot, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(otherRoot, { recursive: true, force: true }); }
});

test("an interrupted pre-spawn run can explicitly resume headless work only", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-headless-"));
  const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const resumed = spawnSync(process.execPath, [...cli, "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).scheduled, true);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, unapproved.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(evidence?.dispatch, "NOT_DISPATCHED");
    const repeated = spawnSync(process.execPath, [...cli, "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).scheduled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless resume refuses a dispatch-uncertain run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-uncertain-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await markDispatchUncertain(root, unapproved);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("headless resume requires an intact job index", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-index-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const index = (await readdir(root)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(root, index), { recursive: true });
    await assert.rejects(resumeHeadlessQaRun(root, unapproved.qaRunId), /QA_INDEX_RECONCILIATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("simultaneous worker-start records have one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-worker-claim-"));
  try {
    const path = join(root, "started");
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => publishQaRecord(path, `worker-${i}\n`)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => (result.reason as NodeJS.ErrnoException).code === "EEXIST"));
    assert.match(await readFile(path, "utf8"), /^worker-[0-7]\n$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("simulated receiver acceptance survives a publisher process crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-acceptance-crash-"));
  const script = `import { createOrInspectRun, claimDispatchIntent } from "./scripts/native-qa/run-store.ts";
    import { runPublishStages } from "./scripts/final-cut-publisher-verification.mjs";
    let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
    const manifest = JSON.parse(text); const root = process.argv[1]; await createOrInspectRun(root, manifest);
    const call = async name => {
      if (name === "artifact.publish.preview") return {jobId:"publish-job-fixture", state:"awaiting-confirmation", artifactDigest:manifest.artifactDigest, targetLibraryPath:"fixture-target"};
      process.send({accepted:true}); await new Promise(() => {});
    };
    await runPublishStages(call, {artifactPath:"fixture-artifact", transactionId:"fixture", targetLibraryPath:"fixture-target", artifactDigest:manifest.artifactDigest}, () => {}, async jobId => { await claimDispatchIntent(root, manifest, jobId); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  try {
    assert.ok(child.stdin);
    child.stdin.end(JSON.stringify(manifest));
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => { throw new Error("simulated receiver process exited before acceptance"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("simulated receiver acceptance timed out")), 10000); timer.unref(); }),
    ]);
    assert.deepEqual(message, { accepted: true });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.publishJobId, "publish-job-fixture");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-fixture"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("client loss before dispatch preserves a resumable headless run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-before-dispatch-"));
  const unapproved = { ...manifest, authorizationDigest: null };
  const script = `import { createOrInspectRun } from "./scripts/native-qa/run-store.ts";
    let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
    await createOrInspectRun(process.argv[1], JSON.parse(text)); process.send({recorded:true}); await new Promise(() => {});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  try {
    assert.ok(child.stdin);
    child.stdin.end(JSON.stringify(unapproved));
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => { throw new Error("client exited before recording the run"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("client recording timed out")), 10000); timer.unref(); }),
    ]);
    assert.deepEqual(message, { recorded: true });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal((await inspectRun(root, unapproved.qaRunId)).dispatch, "NOT_DISPATCHED");
    assert.equal((await createOrInspectRun(root, unapproved)).created, false);
    assert.equal((await resumeHeadlessQaRun(root, unapproved.qaRunId)).scheduled, true);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, unapproved.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(evidence?.dispatch, "NOT_DISPATCHED");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});


test("artifact verification records a sanitized digest snapshot without authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const contents = "<fcpxml>fixture</fcpxml>\n";
    await writeFile(path, contents);
    const unapproved = { ...manifest, authorizationDigest: null, artifactDigest: createHash("sha256").update(contents).digest("hex") };
    await createOrInspectRun(root, unapproved);
    const evidence = await verifyQaArtifact(root, unapproved.qaRunId, path);
    assert.equal(evidence.result, "digest-matched");
    assert.equal(evidence.tier, "artifact");
    assert.equal(evidence.scope, "snapshot-only");
    assert.equal(evidence.artifactDigest, unapproved.artifactDigest);
    assert.equal(evidence.dispatchAllowed, false);
    assert.equal(JSON.stringify(evidence).includes(path), false);
    assert.deepEqual(await readQaArtifactEvidence(root, unapproved.qaRunId), evidence);
    assert.deepEqual(await verifyQaArtifact(root, unapproved.qaRunId, path), evidence);
    await writeFile(path, "changed artifact");
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, path), /QA_ARTIFACT_DIGEST_MISMATCH/);
    assert.deepEqual(await readQaArtifactEvidence(root, unapproved.qaRunId), evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact mismatch and symlinks never create matching evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-invalid-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const link = join(root, "fixture-link.fcpxml");
    await writeFile(path, "unapproved");
    await symlink(path, link);
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, path), /QA_ARTIFACT_DIGEST_MISMATCH/);
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, link), /QA_ARTIFACT_UNSAFE/);
    assert.equal(await readQaArtifactEvidence(root, unapproved.qaRunId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI verifies and retrieves artifact evidence without exposing its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-cli-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const contents = "<fcpxml/>\n";
    await writeFile(path, contents);
    const unapproved = { ...manifest, authorizationDigest: null, artifactDigest: createHash("sha256").update(contents).digest("hex") };
    await createOrInspectRun(root, unapproved);
    const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
    const verified = spawnSync(process.execPath, [...cli, "verify-artifact", root, unapproved.qaRunId, path], { encoding: "utf8", timeout: 10000 });
    assert.equal(verified.status, 0, verified.stderr);
    const record = JSON.parse(verified.stdout);
    assert.equal(record.result, "digest-matched");
    assert.equal(record.scope, "snapshot-only");
    assert.equal(record.dispatchAllowed, false);
    assert.equal(verified.stdout.includes(path), false);
    const read = spawnSync(process.execPath, [...cli, "artifact-evidence", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), record);
  } finally { await rm(root, { recursive: true, force: true }); }
});
