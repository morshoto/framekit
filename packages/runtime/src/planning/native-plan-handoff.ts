import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CreativeBriefStore } from "../application/creative-brief-store.js";
import type { RationalTime, TimeRange } from "../domain/primitives.js";
import { addRationalTimes } from "../timeline/rational-time.js";
import type { AnalysisArtifactStore, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";
import { assertEditDecisionPlanCurrent } from "./edit-decision-plan.js";
import type { EditDecisionPlan, EditDecisionPlanRequest } from "./edit-decision-plan.js";

/** Caller-supplied target to be independently resolved by the native preview path. */
export interface NativePlanTarget {
  libraryId: string;
  eventId: string;
  projectId: string;
  sequenceId: string;
}

/** Recheck the entire proposal against current evidence; this does not authorize execution. */
export async function assertNativeCutHandoffCurrent(
  request: EditDecisionPlanRequest, plan: EditDecisionPlan, decisionIndex: number, target: NativePlanTarget,
  proposal: NativeCutHandoff, artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier, briefStore: CreativeBriefStore,
): Promise<{ status: "current" } | { status: "stale"; reason: string }> {
  let expected: NativeCutHandoff;
  try { expected = structuredClone(proposal); }
  catch { return { status: "stale", reason: "Proposal cannot be safely inspected." }; }
  const current = await prepareNativeCutHandoff(request, plan, decisionIndex, target, artifacts, verifySource, briefStore);
  if (current.status !== "proposed") return { status: "stale", reason: current.reason };
  return isDeepStrictEqual(current, expected) ? { status: "current" } : { status: "stale", reason: "Native proposal or target changed." };
}

export type NativeCutHandoff =
  | { status: "unavailable"; reason: string }
  | {
      status: "proposed";
      authorization: "not-authorized";
      operationId: string;
      target: NativePlanTarget;
      planDigest: string;
      revision: EditDecisionPlan["revision"];
      source: EditDecisionPlan["source"];
      sourceRange: TimeRange;
      occurrenceId: string;
      analysisRef: AnalysisRef;
      operation: { type: "delete-range"; start: RationalTime; end: RationalTime };
    };

/**
 * Prepare a review-only range proposal. Native identity, ripple effects, recovery,
 * preview and per-operation approval remain separate prerequisites for execution.
 */
export async function prepareNativeCutHandoff(
  request: EditDecisionPlanRequest, plan: EditDecisionPlan, decisionIndex: number, target: NativePlanTarget,
  artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier, briefStore: CreativeBriefStore,
): Promise<NativeCutHandoff> {
  try {
    const boundRequest = structuredClone(request);
    const boundPlan = structuredClone(plan);
    const boundTarget = structuredClone(target);
    if (!boundTarget || ![boundTarget.libraryId, boundTarget.eventId, boundTarget.projectId, boundTarget.sequenceId].every((id) => typeof id === "string" && id.trim().length > 0)
      || boundTarget.projectId !== boundPlan.projectId || boundTarget.sequenceId !== boundPlan.timelineId) {
      return { status: "unavailable", reason: "Native target does not match the reviewed project and sequence." };
    }
    if (!Number.isSafeInteger(decisionIndex) || decisionIndex < 0) return { status: "unavailable", reason: "A single reviewed decision is required." };
    const validity = await assertEditDecisionPlanCurrent(boundRequest, boundPlan, artifacts, verifySource, briefStore);
    if (validity.status !== "current") return { status: "unavailable", reason: validity.reason };
    const decision = boundPlan.decisions[decisionIndex];
    if (!decision || decision.kind !== "cut" || decision.candidate.occurrenceId !== boundPlan.occurrenceId
      || !decision.range.startTime || !decision.range.durationTime) {
      return { status: "unavailable", reason: "An exact, source-bound cut candidate is required." };
    }
    const start = structuredClone(decision.range.startTime);
    const end = addRationalTimes(start, decision.range.durationTime);
    const identity = { target: boundTarget, planDigest: boundPlan.planDigest, decisionIndex,
      revision: boundPlan.revision, source: boundPlan.source, sourceRange: decision.candidate.sourceRange, occurrenceId: boundPlan.occurrenceId,
      analysisRef: decision.analysisRef, operation: { type: "delete-range", start, end } };
    const encoded = JSON.stringify(identity, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
    const operationId = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    return { status: "proposed", authorization: "not-authorized", operationId, target: boundTarget,
      planDigest: boundPlan.planDigest, revision: boundPlan.revision, source: boundPlan.source, sourceRange: decision.candidate.sourceRange,
      occurrenceId: boundPlan.occurrenceId, analysisRef: decision.analysisRef,
      operation: { type: "delete-range", start, end } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Native proposal is unavailable." };
  }
}
