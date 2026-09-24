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

function sameTarget(left: CanonicalSyncTarget, right: CanonicalSyncTarget): boolean {
  return left.projectId === right.projectId && left.sequenceId === right.sequenceId;
}
