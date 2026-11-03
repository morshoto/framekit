import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";

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
