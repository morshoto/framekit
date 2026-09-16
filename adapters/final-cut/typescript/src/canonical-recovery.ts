import {
  assertTimelineTargetReadAfterWrite,
  canonicalSnapshotDigest,
  type ProjectSnapshot,
  type TimelineTarget,
} from "@framekit/runtime";

export interface CanonicalRecoveryResult {
  attempted: true;
  succeeded: true;
  operationId: string;
  beforeDigest: string;
  restoredDigest: string;
}

export interface CanonicalRecoveryRequest {
  operationId: string;
  before: ProjectSnapshot;
  target: TimelineTarget;
  undo: (operationId: string) => Promise<{ undone: boolean; verification?: { verified: boolean } }>;
  readSnapshot: () => Promise<ProjectSnapshot>;
}

/** Recover one verified native mutation and prove the original target digest. */
export async function recoverCanonicalNativeMutation(
  request: CanonicalRecoveryRequest,
): Promise<CanonicalRecoveryResult> {
  if (!request.operationId.trim()) {
    throw new Error("FINAL_CUT_CANONICAL_ROLLBACK_FAILED: native operation handle is missing");
  }

  let undone: Awaited<ReturnType<CanonicalRecoveryRequest["undo"]>>;
  try {
    undone = await request.undo(request.operationId);
  } catch (error) {
    throw new Error(`FINAL_CUT_CANONICAL_ROLLBACK_FAILED: native Undo failed: ${String(error)}`);
  }
  if (!undone.undone || undone.verification?.verified !== true) {
    throw new Error("FINAL_CUT_CANONICAL_ROLLBACK_FAILED: native Undo did not verify restoration");
  }

  const restored = await request.readSnapshot();
  assertTimelineTargetReadAfterWrite(request.target, request.before, restored);
  const beforeDigest = canonicalSnapshotDigest(request.before);
  const restoredDigest = canonicalSnapshotDigest(restored);
  if (restoredDigest !== beforeDigest) {
    throw new Error("FINAL_CUT_CANONICAL_ROLLBACK_FAILED: restored canonical digest does not match the pre-edit state");
  }
  return {
    attempted: true,
    succeeded: true,
    operationId: request.operationId,
    beforeDigest,
    restoredDigest,
  };
}
