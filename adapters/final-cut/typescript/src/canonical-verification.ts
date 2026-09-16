import {
  assertTimelineTargetReadAfterWrite,
  canonicalSnapshotDigest,
  diffSnapshots,
  type ProjectSnapshot,
  type TimelineDiff,
  type TimelineTarget,
} from "@framekit/runtime";

export interface CanonicalReadbackEvidence {
  beforeDigest: string;
  afterDigest: string;
  diff: TimelineDiff;
}

export interface CanonicalReadbackOptions {
  validateDiff?: (diff: TimelineDiff) => void;
}

/** Validate one canonical before/after pair and return its durable evidence. */
export function verifyCanonicalReadback(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  target: TimelineTarget,
  options: CanonicalReadbackOptions = {},
): CanonicalReadbackEvidence {
  const beforeDigest = canonicalSnapshotDigest(before);
  const afterDigest = canonicalSnapshotDigest(after);
  if (beforeDigest === afterDigest) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: native edit did not change the canonical digest");
  }

  if (after.revision.id === before.revision.id || after.revision.sequence <= before.revision.sequence) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: revision did not advance after native mutation");
  }

  assertTimelineTargetReadAfterWrite(target, before, after);
  const diff = diffSnapshots(before, after);
  options.validateDiff?.(diff);
  return { beforeDigest, afterDigest, diff };
}
