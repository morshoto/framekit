import type { ContextRevision } from "./primitives.js";

export const CANONICAL_INCREMENTAL_SYNC_CONTRACT_VERSION = 1 as const;

export type CanonicalSyncEvidenceTier =
  | "metadata-only"
  | "artifact-only"
  | "canonical-read"
  | "canonical-live"
  | "headed-native"
  | "fixture";

export type CanonicalSyncSurface = "live" | "artifact" | "fixture";

export interface CanonicalSyncTarget {
  /** Stable provider identity; names are descriptive and never sufficient. */
  projectId: string;
  /** Stable provider identity for the selected sequence/timeline. */
  sequenceId: string;
}

export interface CanonicalSyncCursor {
  target: CanonicalSyncTarget;
  revision: ContextRevision;
}

export interface CanonicalSyncSource {
  provider: string;
  backend: string;
  surface: CanonicalSyncSurface;
  evidenceTier: CanonicalSyncEvidenceTier;
}

export interface CanonicalSyncProvenance {
  source: CanonicalSyncSource;
  observedAt: string;
}

export type CanonicalChangeEntity =
  | "clip"
  | "connected-item"
  | "marker"
  | "caption"
  | "role"
  | "audio"
  | "playhead";

export type CanonicalChangeOperation = "added" | "removed" | "modified";

export interface CanonicalSyncChange {
  /** Contiguous zero-based order within one result. */
  order: number;
  revision: ContextRevision;
  entity: CanonicalChangeEntity;
  operation: CanonicalChangeOperation;
  /** Stable identity of the changed entity; playhead uses the target timeline ID. */
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export interface CanonicalSyncSuccess {
  contractVersion: typeof CANONICAL_INCREMENTAL_SYNC_CONTRACT_VERSION;
  ok: true;
  status: "complete";
  target: CanonicalSyncTarget;
  from: CanonicalSyncCursor;
  to: CanonicalSyncCursor;
  changes: CanonicalSyncChange[];
  provenance: CanonicalSyncProvenance;
}

export type CanonicalSyncFailureStatus = "unavailable" | "stale" | "ambiguous";
export type CanonicalSyncFailureCode =
  | "CAPABILITY_UNAVAILABLE"
  | "METADATA_ONLY"
  | "STALE_CURSOR"
  | "AMBIGUOUS_TARGET"
  | "TARGET_MISMATCH";

export interface CanonicalSyncFailure {
  contractVersion: typeof CANONICAL_INCREMENTAL_SYNC_CONTRACT_VERSION;
  ok: false;
  status: CanonicalSyncFailureStatus;
  target?: CanonicalSyncTarget;
  cursor?: CanonicalSyncCursor;
  provenance?: CanonicalSyncProvenance;
  failure: {
    code: CanonicalSyncFailureCode;
    message: string;
  };
}

export type CanonicalSyncResult = CanonicalSyncSuccess | CanonicalSyncFailure;

/**
 * Validates the structural guarantees shared by timeline.changes and
 * context.changes. Provider-specific payload validation belongs at the edge.
 */
export function assertCanonicalSyncResult(result: CanonicalSyncResult): void {
  if (result.contractVersion !== CANONICAL_INCREMENTAL_SYNC_CONTRACT_VERSION) {
    throw new Error("CANONICAL_SYNC_INVALID: unsupported contract version");
  }
  if (!result.ok) {
    assertFailure(result);
    return;
  }
  assertTarget(result.target);
  assertCursor(result.from);
  assertCursor(result.to);
  if (!sameTarget(result.target, result.from.target) || !sameTarget(result.target, result.to.target)) {
    throw new Error("CANONICAL_SYNC_INVALID: result cursors are not bound to the target");
  }
  if (result.to.revision.sequence < result.from.revision.sequence) {
    throw new Error("CANONICAL_SYNC_INVALID: to revision precedes from revision");
  }
  assertProvenance(result.provenance);
  if (result.provenance.source.evidenceTier === "metadata-only") {
    throw new Error("CANONICAL_SYNC_INVALID: metadata-only evidence cannot return canonical changes");
  }
  assertChanges(result.changes, result.from.revision, result.to.revision);
}

function assertFailure(result: CanonicalSyncFailure): void {
  if (!result.failure.message.trim()) {
    throw new Error("CANONICAL_SYNC_INVALID: failure message is required");
  }
  if (result.status === "unavailable"
    && !["CAPABILITY_UNAVAILABLE", "METADATA_ONLY"].includes(result.failure.code)) {
    throw new Error("CANONICAL_SYNC_INVALID: unavailable result has the wrong failure code");
  }
  if (result.status === "stale" && result.failure.code !== "STALE_CURSOR") {
    throw new Error("CANONICAL_SYNC_INVALID: stale result has the wrong failure code");
  }
  if (result.status === "ambiguous" && result.failure.code !== "AMBIGUOUS_TARGET") {
    throw new Error("CANONICAL_SYNC_INVALID: ambiguous result has the wrong failure code");
  }
  if (result.target) assertTarget(result.target);
  if (result.cursor) assertCursor(result.cursor);
  if (result.provenance) assertProvenance(result.provenance);
}

function assertCursor(cursor: CanonicalSyncCursor): void {
  assertTarget(cursor.target);
  assertRevision(cursor.revision);
}

function assertTarget(target: CanonicalSyncTarget): void {
  if (!target.projectId.trim() || !target.sequenceId.trim()) {
    throw new Error("CANONICAL_SYNC_INVALID: stable project and sequence identities are required");
  }
}

function assertRevision(revision: ContextRevision): void {
  if (!revision.id.trim() || !Number.isInteger(revision.sequence) || revision.sequence < 0) {
    throw new Error("CANONICAL_SYNC_INVALID: valid revision identity is required");
  }
  if (!Number.isFinite(Date.parse(revision.timestamp))) {
    throw new Error("CANONICAL_SYNC_INVALID: revision timestamp is invalid");
  }
}

function assertProvenance(provenance: CanonicalSyncProvenance): void {
  if (!provenance.source.provider.trim() || !provenance.source.backend.trim()) {
    throw new Error("CANONICAL_SYNC_INVALID: provider and backend provenance are required");
  }
  if (!Number.isFinite(Date.parse(provenance.observedAt))) {
    throw new Error("CANONICAL_SYNC_INVALID: observation timestamp is invalid");
  }
}

function assertChanges(
  changes: CanonicalSyncChange[],
  from: ContextRevision,
  to: ContextRevision,
): void {
  let previous: CanonicalSyncChange | undefined;
  changes.forEach((change, index) => {
    if (change.order !== index) {
      throw new Error("CANONICAL_SYNC_INVALID: change order must be contiguous");
    }
    assertRevision(change.revision);
    if (change.revision.sequence < from.sequence || change.revision.sequence > to.sequence) {
      throw new Error("CANONICAL_SYNC_INVALID: change revision is outside the result cursor");
    }
    if (!change.entityId.trim()) {
      throw new Error("CANONICAL_SYNC_INVALID: change entity identity is required");
    }
    const hasBefore = Object.prototype.hasOwnProperty.call(change, "before");
    const hasAfter = Object.prototype.hasOwnProperty.call(change, "after");
    if (change.operation === "added" && (!hasAfter || hasBefore)) {
      throw new Error("CANONICAL_SYNC_INVALID: added change must have after only");
    }
    if (change.operation === "removed" && (!hasBefore || hasAfter)) {
      throw new Error("CANONICAL_SYNC_INVALID: removed change must have before only");
    }
    if (change.operation === "modified" && (!hasBefore || !hasAfter)) {
      throw new Error("CANONICAL_SYNC_INVALID: modified change must have before and after");
    }
    if (previous && compareChanges(previous, change) > 0) {
      throw new Error("CANONICAL_SYNC_INVALID: changes must be deterministically ordered");
    }
    previous = change;
  });
}

const ENTITY_ORDER: Record<CanonicalChangeEntity, number> = {
  clip: 0,
  "connected-item": 1,
  marker: 2,
  caption: 3,
  role: 4,
  audio: 5,
  playhead: 6,
};

const OPERATION_ORDER: Record<CanonicalChangeOperation, number> = {
  added: 0,
  modified: 1,
  removed: 2,
};

function compareChanges(left: CanonicalSyncChange, right: CanonicalSyncChange): number {
  return left.revision.sequence - right.revision.sequence
    || ENTITY_ORDER[left.entity] - ENTITY_ORDER[right.entity]
    || left.entityId.localeCompare(right.entityId)
    || OPERATION_ORDER[left.operation] - OPERATION_ORDER[right.operation];
}

function sameTarget(left: CanonicalSyncTarget, right: CanonicalSyncTarget): boolean {
  return left.projectId === right.projectId && left.sequenceId === right.sequenceId;
}
