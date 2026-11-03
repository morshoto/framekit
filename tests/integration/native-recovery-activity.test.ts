import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";
import * as native from "../../adapters/final-cut/typescript/src/native.js";

test("another guard cannot recover while a publisher is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-activity-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  const jobId = "publish-job-123";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "receiver-1",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64),
    requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  try {
    const owner = await (guard.beginNative as any)(operation, context, { trackExecution: true });
    let verified = false;
    const verify = async () => { verified = true; return { receiptId: "receipt", outcome: "completed" as const }; };
    await assert.rejects(other.completeVerifiedNative(owner.reservationId, "completed", verify), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal(verified, false);
    assert.equal((await other.inspectNativeReservation())?.reservationId, owner.reservationId);
    await owner.finishExecution();
    await assert.rejects(other.beginNativeExecution("c".repeat(64)), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const finishContinuation = await other.beginNativeExecution(owner.reservationId);
    await assert.rejects(guard.beginNativeExecution(owner.reservationId), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(guard.completeVerifiedNative(owner.reservationId, "completed", verify), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await finishContinuation();
    assert.deepEqual(await other.completeVerifiedNative(owner.reservationId, "completed", verify), { outcome: "completed", alreadyReleased: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an orphaned execution marker blocks canonical and native reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-orphaned-activity-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  try {
    await guard.beginNative("native.searchmedia", undefined, { trackExecution: true });
    await rm(path); // Simulate an interrupted or externally altered test fixture.
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(guard.beginNative("native.searchmedia"), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(guard.begin({ projectId: "project", sequenceId: "sequence", baseRevision: "revision", beforeDigest: "a".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sender status remains inspectable after restart without asserting native quiescence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-sender-inspection-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const restarted = new FileCanonicalRecoveryGuard(path);
  const inspect = (id: string) => (restarted as any).inspectNativeSender(id);
  try {
    const legacy = await guard.beginNative("native.searchmedia");
    assert.deepEqual(await inspect(legacy.reservationId), { status: "untracked", nativeQuiescence: "unproven" });
    await legacy.release();
    const tracked = await guard.beginNative("native.searchmedia", undefined, { trackExecution: true });
    assert.deepEqual(await inspect(tracked.reservationId), { status: "active-or-interrupted", nativeQuiescence: "unproven" });
    await assert.rejects(inspect("c".repeat(64)), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await tracked.finishExecution!();
    assert.deepEqual(await inspect(tracked.reservationId), { status: "sender-settled", nativeQuiescence: "unproven" });
    await rm(join(`${path}.sender-settled`, tracked.reservationId));
    assert.deepEqual(await inspect(tracked.reservationId), { status: "unknown", nativeQuiescence: "unproven" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("aborted sender execution remains pending until the child closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-child-"));
  const ready = join(directory, "ready");
  const controller = new AbortController();
  let pid: number | undefined;
  const run = (native as unknown as { executeNativeSender: (command: string, args: string[], signal: AbortSignal) => Promise<unknown> }).executeNativeSender;
  try {
    const pending = run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ready], controller.signal);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { pid = Number(await readFile(ready, "utf8")); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pid && Number.isSafeInteger(pid));
    controller.abort();
    const settled = await Promise.race([pending.then(() => true, () => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))]);
    assert.equal(settled, false, "abort must not be reported as executor settlement while the child is alive");
    process.kill(pid, "SIGKILL");
    pid = undefined;
    await assert.rejects(pending);
  } finally {
    if (pid) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});


test("repeated recovery rejects a malformed completed receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-receipt-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const jobId = "publish-job-123";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "receiver-1",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64),
    requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  try {
    const owner = await (guard.beginNative as any)(operation, context, { trackExecution: true });
    await owner.finishExecution();
    const verify = async () => ({ receiptId: "receipt", outcome: "completed" as const });
    await guard.completeVerifiedNative(owner.reservationId, "completed", verify);
    const proof = join(`${path}.completed`, `${owner.reservationId}.proof`);
    await writeFile(proof, JSON.stringify({ reservationId: owner.reservationId, outcome: "completed", receiptId: "x".repeat(1025) }));
    const restarted = new FileCanonicalRecoveryGuard(path);
    await assert.rejects(restarted.inspectCompletedNativeEvidence(owner.reservationId), /RECOVERY_EVIDENCE_INVALID/);
    await assert.rejects(restarted.completeVerifiedNative(owner.reservationId, "completed", verify), /RECOVERY_EVIDENCE_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
