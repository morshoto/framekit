import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanonicalSyncResult,
  type CanonicalSyncSuccess,
} from "@framekit/runtime";

const target = {
  projectId: "project-1",
  sequenceId: "sequence-1",
} as const;

function revision(id: string, sequence: number) {
  return {
    id,
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
  };
}

function completeResult(
  evidenceTier: CanonicalSyncSuccess["provenance"]["source"]["evidenceTier"] = "canonical-live",
): CanonicalSyncSuccess {
  const from = { target, revision: revision("rev-1", 1) };
  const to = { target, revision: revision("rev-1", 1) };
  return {
    contractVersion: 1,
    ok: true,
    status: "complete",
    target,
    from,
    to,
    changes: [],
    provenance: {
      source: {
        provider: "fixture-provider",
        backend: "fixture",
        surface: "fixture",
        evidenceTier,
      },
      observedAt: "2026-09-25T00:00:00.000Z",
    },
  };
}

test("accepts an empty target-bound canonical result", () => {
  assert.doesNotThrow(() => assertCanonicalSyncResult(completeResult()));
});

test("rejects metadata-only observations as canonical changes", () => {
  assert.throws(
    () => assertCanonicalSyncResult(completeResult("metadata-only")),
    /metadata-only evidence cannot return canonical changes/,
  );
});
