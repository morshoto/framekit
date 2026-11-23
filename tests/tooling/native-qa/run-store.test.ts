import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimDispatchIntent, createOrInspectRun, inspectRun, markDispatchUncertain } from "../../../scripts/native-qa/run-store.js";
import { runPublishStages } from "../../../scripts/final-cut-publisher-verification.mjs";

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
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "another-run" }), /QA_AUTHORIZATION_ALREADY_BOUND/);
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "changed-run", targetDigest: "9".repeat(64) }), /QA_AUTHORIZATION_ALREADY_BOUND/);
    const separate = await createOrInspectRun(root, { ...manifest, qaRunId: "separate-run", authorizationDigest: "a".repeat(64) });
    assert.equal(separate.created, true);
    assert.equal(separate.run.verdict, "BLOCKED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent different run IDs cannot consume the same authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-race-"));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createOrInspectRun(root, { ...manifest, qaRunId: `run-${i}` })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => /QA_AUTHORIZATION_ALREADY_BOUND/.test(String(result.reason))));
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
