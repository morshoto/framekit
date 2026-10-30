import type { ContextRevision } from "../domain/primitives.js";
import {
  EditingSession,
  timelineIrDigest,
  validateTimelineIr,
  type EditingSessionState,
  type TimelineIr,
} from "./editing-session.js";
import type { TimelineReconciliationResult } from "./drift-reconciliation.js";

export const FAST_TIMELINE_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type FastTimelineCoverageState = "complete" | "partial" | "unknown";
export type FastTimelineTrust = "normalized" | "structural" | "evidence-only";
export type FastTimelineFreshness = "editor-read" | "storage-observed" | "unknown";

export interface FastTimelineObservationTarget {
  projectId: string;
  sequenceId: string;
}

export interface FastTimelineObservationProvenance {
  framekitRevision: ContextRevision;
  artifactDigest: string;
  target: FastTimelineObservationTarget;
}

/** Provider-neutral evidence envelope. A timeline is optional because most fast providers are partial. */
export interface FastTimelineObservation {
  schemaVersion: typeof FAST_TIMELINE_OBSERVATION_SCHEMA_VERSION;
  provider: string;
  sourceType: string;
  canonical: false;
  target: FastTimelineObservationTarget;
  provenance: FastTimelineObservationProvenance;
  observedAt: string;
  trust: FastTimelineTrust;
  freshness: FastTimelineFreshness;
  revision: ContextRevision;
  observationDigest: string;
  timelineDigest?: string;
  coverage: {
    occurrences: FastTimelineCoverageState;
    resources: FastTimelineCoverageState;
    timing: FastTimelineCoverageState;
    roles: FastTimelineCoverageState;
    storylineRelationships: FastTimelineCoverageState;
    markersCaptions: FastTimelineCoverageState;
  };
  unknowns: string[];
  timeline?: TimelineIr;
}

export interface FastTimelineNormalizationInput extends Omit<FastTimelineObservation, "timeline" | "timelineDigest"> {
  timeline?: TimelineIr;
  timelineDigest?: string;
}

export type FastTimelineReconciliationStatus =
  | "unchanged"
  | "advanced-by-framekit"
  | "proven-structural-delta"
  | "possibly-stale"
  | "conflicted"
  | "canonical-resync-required"
  | "target-mismatch"
  | "provider-incompatible";

export interface FastTimelineSessionEvidence {
  state: EditingSessionState;
  base: TimelineIr;
  desired: TimelineIr;
  serialized: string;
}

export type FastTimelineReconciliation = {
  status: FastTimelineReconciliationStatus;
  canonical: false;
  provider: string;
  sourceType: string;
  revision: ContextRevision;
  coverage: FastTimelineObservation["coverage"];
  unknowns: string[];
  reason: string;
  session: FastTimelineSessionEvidence;
  reconciliation?: TimelineReconciliationResult;
};

/**
 * Normalize an adapter-produced envelope at the runtime boundary.
 * The runtime validates the optional Timeline IR but never invents unknown fields.
 */
export function normalizeFastTimelineObservation(input: FastTimelineNormalizationInput): FastTimelineObservation {
  const observation = structuredClone(input) as FastTimelineObservation;
  validateObservationEnvelope(observation);
  if (observation.timeline) {
    validateTimelineIr(observation.timeline);
    if (!observation.timelineDigest) observation.timelineDigest = timelineIrDigest(observation.timeline);
  }
  return observation;
}

/**
 * Reconcile provider evidence through the real EditingSession state machine.
 * Partial evidence never replaces the known canonical baseline.
 */
export function reconcileFastTimelineObservation(input: {
  session: EditingSession;
  observation: FastTimelineObservation;
}): FastTimelineReconciliation {
  const { session, observation } = input;
  const base = session.base();
  const common = {
    canonical: false as const,
    provider: observation.provider,
    sourceType: observation.sourceType,
    revision: structuredClone(observation.revision),
    coverage: structuredClone(observation.coverage),
    unknowns: [...observation.unknowns],
  };
  const finish = (
    status: FastTimelineReconciliationStatus,
    reason: string,
    reconciliation?: TimelineReconciliationResult,
  ): FastTimelineReconciliation => ({
    ...common,
    status,
    reason,
    session: sessionEvidence(session),
    ...(reconciliation ? { reconciliation } : {}),
  });

  try {
    validateObservationEnvelope(observation);
  } catch (error) {
    session.markConflicted();
    return finish("canonical-resync-required", errorMessage(error));
  }

  const expectedProvider = session.document().provider?.id;
  if (expectedProvider && observation.provider !== expectedProvider) {
    session.markConflicted();
    return finish("provider-incompatible", `observation provider ${observation.provider} is incompatible with session provider ${expectedProvider}`);
  }
  if (!sameTarget(observation.target, { projectId: base.project.id, sequenceId: base.sequence.id })
    || !sameTarget(observation.provenance.target, observation.target)) {
    session.markConflicted();
    return finish("target-mismatch", "observation target or materialization provenance does not match the session");
  }
  if (!observation.timeline) {
    session.markPossiblyStale();
    return finish("possibly-stale", "observation has no normalized Timeline IR; known canonical fields are preserved");
  }
  if (!observation.timelineDigest || timelineIrDigest(observation.timeline) !== observation.timelineDigest) {
    session.markConflicted();
    return finish("canonical-resync-required", "observation timeline digest does not match normalized Timeline IR");
  }
  if (!sameRevision(observation.timeline.revision, observation.revision)) {
    session.markConflicted();
    return finish("canonical-resync-required", "observation revision does not match normalized Timeline IR revision");
  }
  if (!completeCoverage(observation.coverage) || observation.unknowns.length > 0) {
    session.markPossiblyStale();
    return finish("possibly-stale", "observation has incomplete coverage or explicit unknown fields");
  }
  if (observation.trust !== "normalized" || observation.freshness !== "editor-read") {
    session.markPossiblyStale();
    return finish("possibly-stale", "observation trust or freshness is insufficient for Timeline IR reconciliation");
  }

  const observedDigest = timelineIrDigest(observation.timeline);
  const baseDigest = timelineIrDigest(base);
  const desiredDigest = timelineIrDigest(session.desired());
  if (observedDigest === baseDigest) {
    if (!sameRevision(base.revision, observation.revision)) {
      session.observeProviderRevision(observation.revision);
      return finish("possibly-stale", "observation matches the baseline but changed provider revision");
    }
    return finish("unchanged", "observation matches the session baseline");
  }

  const reconciliation = session.reconcile(observation.timeline);
  if (reconciliation.status === "conflicted") {
    return finish("conflicted", "observation conflicts with the session desired state", reconciliation);
  }
  if (observedDigest === desiredDigest && desiredDigest !== baseDigest) {
    return finish("advanced-by-framekit", "observation proves the expected Framekit desired timeline", reconciliation);
  }
  return finish("proven-structural-delta", "complete normalized evidence advanced the session baseline", reconciliation);
}

function sessionEvidence(session: EditingSession): FastTimelineSessionEvidence {
  return {
    state: session.state(),
    base: session.base(),
    desired: session.desired(),
    serialized: session.serialize(),
  };
}

function validateObservationEnvelope(observation: FastTimelineObservation): void {
  if (!observation || observation.schemaVersion !== FAST_TIMELINE_OBSERVATION_SCHEMA_VERSION) {
    throw new Error("FAST_TIMELINE_OBSERVATION_INVALID: unsupported schema version");
  }
  for (const [name, value] of Object.entries({
    provider: observation.provider,
    sourceType: observation.sourceType,
    observedAt: observation.observedAt,
    observationDigest: observation.observationDigest,
    artifactDigest: observation.provenance?.artifactDigest,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`FAST_TIMELINE_OBSERVATION_INVALID: ${name} is required`);
  }
  if (!observation.target?.projectId?.trim() || !observation.target.sequenceId?.trim()) {
    throw new Error("FAST_TIMELINE_OBSERVATION_INVALID: target identity is required");
  }
  if (!sameTarget(observation.provenance.target, observation.target)) {
    throw new Error("FAST_TIMELINE_OBSERVATION_INVALID: provenance target differs from observation target");
  }
  if (observation.canonical !== false || !Array.isArray(observation.unknowns)) {
    throw new Error("FAST_TIMELINE_OBSERVATION_INVALID: evidence must remain non-canonical with explicit unknowns");
  }
  if (observation.timeline && observation.timelineDigest !== undefined && typeof observation.timelineDigest !== "string") {
    throw new Error("FAST_TIMELINE_OBSERVATION_INVALID: timelineDigest must be a string");
  }
}

function completeCoverage(coverage: FastTimelineObservation["coverage"]): boolean {
  return Object.values(coverage).every((state) => state === "complete");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}

function sameTarget(left: FastTimelineObservationTarget | undefined, right: FastTimelineObservationTarget): boolean {
  return left?.projectId === right.projectId && left?.sequenceId === right.sequenceId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
