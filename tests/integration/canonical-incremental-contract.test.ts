import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import {
  assertCanonicalSyncResult,
  type CanonicalSyncChange,
  type CanonicalSyncSurface,
  type CanonicalSyncFailure,
  type CanonicalSyncSuccess,
} from "@framekit/runtime";

const target = {
  projectId: "project-1",
  sequenceId: "sequence-1",
} as const;

const contractDocumentation = readFileSync(join(
  process.cwd(),
  "docs/architecture/canonical-incremental-synchronization.md",
), "utf8");

function revision(id: string, sequence: number) {
  return {
    id,
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
  };
}

function completeResult(
  evidenceTier: CanonicalSyncSuccess["provenance"]["source"]["evidenceTier"] = "fixture",
  changes: CanonicalSyncChange[] = [],
  surface: CanonicalSyncSurface = surfaceForEvidence(evidenceTier),
): CanonicalSyncSuccess {
  const from = { target, revision: revision("rev-1", 1) };
  const to = { target, revision: changes.at(-1)?.revision ?? revision("rev-1", 1) };
  return {
    contractVersion: 1,
    ok: true,
    status: "complete",
    target,
    from,
    to,
    changes,
    provenance: {
      source: {
        provider: "fixture-provider",
        backend: "fixture",
        surface,
        evidenceTier,
      },
      observedAt: "2026-09-25T00:00:00.000Z",
    },
  };
}

function surfaceForEvidence(
  evidenceTier: CanonicalSyncSuccess["provenance"]["source"]["evidenceTier"],
): CanonicalSyncSurface {
  if (evidenceTier === "fixture") return "fixture";
  if (evidenceTier === "artifact-only" || evidenceTier === "canonical-read") return "artifact";
  return "live";
}

function failureResult(
  status: CanonicalSyncFailure["status"],
  code: CanonicalSyncFailure["failure"]["code"],
): CanonicalSyncFailure {
  return {
    contractVersion: 1,
    ok: false,
    status,
    target,
    ...(status === "stale" ? { cursor: { target, revision: revision("rev-1", 1) } } : {}),
    failure: {
      code,
      message: `${status} state requires a fresh canonical observation`,
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

test("rejects canonical-live evidence from an artifact surface", () => {
  assert.throws(
    () => assertCanonicalSyncResult(completeResult("canonical-live", [], "artifact")),
    /evidence tier canonical-live is incompatible with surface artifact/,
  );
});

test("rejects headed-native evidence from a fixture surface", () => {
  assert.throws(
    () => assertCanonicalSyncResult(completeResult("headed-native", [], "fixture")),
    /evidence tier headed-native is incompatible with surface fixture/,
  );
});

test("accepts ordered changes with operation-specific before and after values", () => {
  assert.doesNotThrow(() => assertCanonicalSyncResult(completeResult("canonical-live", [
    {
      order: 0,
      revision: revision("rev-2", 2),
      entity: "clip",
      operation: "added",
      entityId: "clip-a",
      after: { name: "A" },
    },
    {
      order: 1,
      revision: revision("rev-3", 3),
      entity: "marker",
      operation: "modified",
      entityId: "marker-a",
      before: { name: "Before" },
      after: { name: "After" },
    },
    {
      order: 2,
      revision: revision("rev-4", 4),
      entity: "clip",
      operation: "removed",
      entityId: "clip-b",
      before: { name: "B" },
    },
  ])));
});

test("rejects changes that are not contiguous and deterministically ordered", () => {
  assert.throws(
    () => assertCanonicalSyncResult(completeResult("canonical-live", [{
      order: 1,
      revision: revision("rev-2", 2),
      entity: "clip",
      operation: "added",
      entityId: "clip-a",
      after: { name: "A" },
    }])),
    /change order must be contiguous/,
  );
});

test("uses code-point order for stable entity IDs", () => {
  assert.doesNotThrow(() => assertCanonicalSyncResult(completeResult("canonical-live", [
    {
      order: 0,
      revision: revision("rev-2", 2),
      entity: "clip",
      operation: "added",
      entityId: "z",
      after: { name: "Z" },
    },
    {
      order: 1,
      revision: revision("rev-2", 2),
      entity: "clip",
      operation: "added",
      entityId: "ä",
      after: { name: "A" },
    },
  ])));
});

test("rejects added and removed changes without exact before-after provenance", () => {
  assert.throws(
    () => assertCanonicalSyncResult(completeResult("canonical-live", [{
      order: 0,
      revision: revision("rev-2", 2),
      entity: "clip",
      operation: "added",
      entityId: "clip-a",
      before: { name: "unexpected" },
      after: { name: "A" },
    }])),
    /added change must have after only/,
  );
});

test("returns a structured stale result bound to the requested cursor", () => {
  assert.doesNotThrow(() => assertCanonicalSyncResult(
    failureResult("stale", "STALE_CURSOR"),
  ));
});

test("rejects a stale result without its revision cursor", () => {
  const result = failureResult("stale", "STALE_CURSOR");
  delete result.cursor;
  assert.throws(
    () => assertCanonicalSyncResult(result),
    /stale result requires a revision cursor/,
  );
});

test("rejects a failure whose target disagrees with its cursor", () => {
  const result = failureResult("stale", "STALE_CURSOR");
  result.cursor!.target = { projectId: "other-project", sequenceId: "sequence-1" };
  assert.throws(
    () => assertCanonicalSyncResult(result),
    /failure target does not match its cursor/,
  );
});

test("documents the canonical incremental synchronization guarantees", () => {
  for (const requirement of [
    "revision cursor",
    "stable project and sequence identities",
    "deterministic order",
    "before and after",
    "provider and backend provenance",
    "metadata-only",
    "stale",
    "ambiguous",
    "unavailable",
    "timeline.changes",
    "context.changes",
  ]) {
    assert.match(contractDocumentation, new RegExp(requirement.replace(".", "\\."), "i"));
  }
});
