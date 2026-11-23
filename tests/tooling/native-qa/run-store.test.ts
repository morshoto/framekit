import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindQaAuthorization, claimDispatchIntent, createOrInspectRun, inspectRun, markDispatchUncertain } from "../../../scripts/native-qa/run-store.js";
import { runPublishStages } from "../../../scripts/final-cut-publisher-verification.mjs";
import { readQaEvidence } from "../../../scripts/native-qa/supervisor.js";
import { publishQaRecord } from "../../../scripts/native-qa/atomic-record.js";

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
    const separate = await createOrInspectRun(root, { ...manifest, qaRunId: "separate-run", authorizationDigest: "a".repeat(64) });
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
    const duplicate = spawnSync(process.execPath, [...cli, "start", root, manifestPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, false);
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
    await createOrInspectRun(root, second);
    await bindQaAuthorization(root, first, "9".repeat(64));
    const duplicate = await bindQaAuthorization(root, second, "9".repeat(64));
    assert.equal(duplicate.bound, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
    await assert.rejects(claimDispatchIntent(root, second, "publish-job-2"), /QA_AUTHORIZATION_REQUIRED/);
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
