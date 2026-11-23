import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOrInspectRun, inspectRun, markDispatchUncertain } from "../../../scripts/native-qa/run-store.js";

const manifest = {
  qaRunId: "qa-fixture-1", candidateCommit: "a".repeat(40), candidateTree: "b".repeat(40),
  packageDigest: "1".repeat(64), pluginDigest: "2".repeat(64), extensionDigest: "3".repeat(64),
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
    for (const changed of [{ candidateCommit: "c".repeat(40) }, { targetDigest: "8".repeat(64) }, { authorizationDigest: "9".repeat(64) }]) {
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
