import type { ContextRevision } from "../domain/primitives.js";
import {
  timelineIrDigest,
  type TimelineIr,
} from "./editing-session.js";
import {
  reconcileTimelineIr,
  type TimelineReconciliationResult,
} from "./drift-reconciliation.js";

export type FastTimelineCoverageState = "complete" | "partial" | "unknown";

export interface FastTimelineObservation {
  provider: string;
  canonical: false;
  target: { projectId: string; sequenceId: string };
  revision: ContextRevision;
  timelineDigest: string;
  coverage: {
    occurrences: FastTimelineCoverageState;
    resources: FastTimelineCoverageState;
    timing: FastTimelineCoverageState;
    roles: FastTimelineCoverageState;
    storylineRelationships: FastTimelineCoverageState;
    markersCaptions: FastTimelineCoverageState;
  };
  timeline?: TimelineIr;
}

export type FastTimelineReconciliation = {
  status: "unchanged" | "advanced-by-framekit" | "possibly-stale" | "conflicted" | "canonical-resync-required";
  canonical: false;
  provider: string;
  revision: ContextRevision;
  coverage: FastTimelineObservation["coverage"];
  reason: string;
  reconciliation?: TimelineReconciliationResult;
};

export function reconcileFastTimelineObservation(input: {
  base: TimelineIr;
  desired: TimelineIr;
  observation: FastTimelineObservation;
}): FastTimelineReconciliation {
  const { base, desired, observation } = input;
  const common = {
    canonical: false as const,
    provider: observation.provider,
    revision: structuredClone(observation.revision),
    coverage: structuredClone(observation.coverage),
  };
  if (observation.canonical !== false
    || observation.target.projectId !== base.project.id
    || observation.target.sequenceId !== base.sequence.id) {
    return { ...common, status: "canonical-resync-required", reason: "fast observation target or trust level is unavailable" };
  }
  if (!completeCoverage(observation.coverage)) {
    return { ...common, status: "canonical-resync-required", reason: "fast observation has incomplete coverage" };
  }
  if (!observation.timeline) {
    return { ...common, status: "canonical-resync-required", reason: "fast observation has no normalized Timeline IR" };
  }
  if (observation.timeline.project.id !== base.project.id || observation.timeline.sequence.id !== base.sequence.id) {
    return { ...common, status: "canonical-resync-required", reason: "normalized observation target does not match the session" };
  }
  const observedDigest = timelineIrDigest(observation.timeline);
  if (observedDigest !== observation.timelineDigest) {
    return { ...common, status: "canonical-resync-required", reason: "fast observation digest does not match normalized Timeline IR" };
  }
  const baseDigest = timelineIrDigest(base);
  const desiredDigest = timelineIrDigest(desired);
  if (observedDigest === baseDigest) {
    return {
      ...common,
      status: sameRevision(base.revision, observation.revision) ? "unchanged" : "possibly-stale",
      reason: sameRevision(base.revision, observation.revision)
        ? "fast observation matches the session base"
        : "fast observation changed revision without proving a structural edit",
    };
  }
  if (desiredDigest !== baseDigest && observedDigest === desiredDigest) {
    return { ...common, status: "advanced-by-framekit", reason: "fast observation proves the expected desired timeline" };
  }
  const reconciliation = reconcileTimelineIr({ base, ours: desired, theirs: observation.timeline });
  if (reconciliation.status === "conflicted") {
    return { ...common, status: "conflicted", reason: "fast observation conflicts with the desired session", reconciliation };
  }
  return {
    ...common,
    status: "possibly-stale",
    reason: desiredDigest === baseDigest
      ? "fast observation proves an external timeline change"
      : "fast observation changed state without proving the expected edit",
    reconciliation,
  };
}

function completeCoverage(coverage: FastTimelineObservation["coverage"]): boolean {
  return Object.values(coverage).every((state) => state === "complete");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
