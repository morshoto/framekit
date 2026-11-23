import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameAnalyzerDescriptor, sameMediaSourceIdentity } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";
import { planCaptionGroups } from "./caption-planning.js";
import type { CaptionGroup, CaptionPlanRequest } from "./caption-planning.js";
import { assertBriefBinding } from "./creative-brief.js";
import type { AcceptedCreativeBrief, CreativeBrief } from "./creative-brief.js";
import { planMusic } from "./music-planning.js";
import type { MusicPlanRequest } from "./music-planning.js";
import { rankNarrativeCutsWithEvidence } from "./narrative-cuts.js";
import type { NarrativeCutCandidate } from "./narrative-cuts.js";

export interface EditDecisionPlanRequest {
  snapshot: ProjectSnapshot;
  projectId: string;
  timelineId: string;
  revision: ContextRevision;
  occurrenceId: string;
  brief: CreativeBrief;
  accepted: AcceptedCreativeBrief;
  speechRef: AnalysisRef;
  vadRef: AnalysisRef;
  speechContext: AnalysisEvidenceContext;
  vadContext: AnalysisEvidenceContext;
  caption: Omit<CaptionPlanRequest, "snapshot" | "projectId" | "timelineId" | "revision" | "occurrenceId">;
  music: Omit<MusicPlanRequest, "snapshot" | "projectId" | "timelineId" | "revision" | "brief" | "accepted">;
}
export type EditDecision =
  | { kind: "cut"; support: "unavailable"; rationale: string; range: TimeRange; candidate: NarrativeCutCandidate; analysisRef: AnalysisRef }
  | { kind: "caption"; support: "unavailable"; rationale: string; range: TimeRange; group: CaptionGroup; analysisRef: AnalysisRef }
  | { kind: "music-omission"; support: "no-op"; rationale: string }
  | { kind: "music-proposal"; support: "unavailable"; rationale: string; range?: TimeRange };
export interface EditDecisionPlan {
  projectId: string;
  timelineId: string;
  occurrenceId: string;
  revision: ContextRevision;
  acceptedBrief: AcceptedCreativeBrief;
  inputDigest: string;
  planDigest: string;
  reviewRequired: true;
  decisions: EditDecision[];
  warnings: string[];
}
export type EditDecisionPlanResult = { status: "available"; plan: EditDecisionPlan } | { status: "unavailable"; reason: string };
export type EditDecisionPlanValidity = { status: "current" } | { status: "stale"; reason: string };

function sameRevision(a: ContextRevision, b: ContextRevision): boolean {
  return !!a && !!b && a.id === b.id && a.sequence === b.sequence && a.timestamp === b.timestamp;
}
function digest(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

/** Integrate verified proposals without executing or silently switching editor backends. */
export async function createEditDecisionPlan(request: EditDecisionPlanRequest, artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier): Promise<EditDecisionPlanResult> {
  try {
    assertBriefBinding(request.accepted, request.brief);
    const snapshot = request.snapshot;
    if (!snapshot || snapshot.projectId !== request.projectId || snapshot.timeline.id !== request.timelineId
      || !sameRevision(snapshot.revision, request.revision) || !sameRevision(request.speechContext.revision, request.revision)
      || !sameRevision(request.vadContext.revision, request.revision) || request.speechContext.kind !== "speech" || request.vadContext.kind !== "vad"
      || !sameMediaSourceIdentity(request.speechContext.source, request.vadContext.source)
      || !sameAnalyzerDescriptor(request.speechContext.provider, request.vadContext.provider)) {
      return { status: "unavailable", reason: "Target, revision or speech/VAD identity differs from the current context." };
    }
    const clips = snapshot.timeline.clips.filter((clip) => clip.id === request.occurrenceId);
    const media = snapshot.media.filter((entry) => entry.mediaId === request.speechContext.source.mediaId);
    const clip = clips.length === 1 ? clips[0] : undefined;
    if (!clip || clip.mediaId !== request.speechContext.source.mediaId || media.length !== 1 || !sameMediaSourceIdentity(media[0]!, request.speechContext.source)
      || !clip.startTime || !clip.durationTime || !snapshot.timeline.frameDuration
      || (clip.sourceStart !== undefined && clip.sourceStart !== 0 && !clip.sourceStartTime)) {
      return { status: "unavailable", reason: "Exact unique occurrence and source identity are required." };
    }
    const sourceStart = clip.sourceStart ?? 0;
    const sourceStartTime = clip.sourceStartTime ?? { value: "0", timescale: "1" };
    const cuts = await rankNarrativeCutsWithEvidence({ projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId,
      revision: request.revision, source: request.speechContext.source,
      sourceRange: { start: sourceStart, end: sourceStart + clip.duration, startTime: sourceStartTime, durationTime: clip.durationTime },
      sequenceRange: { start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime },
      sequenceFrameDuration: snapshot.timeline.frameDuration }, request.vadRef, request.vadContext, artifacts, verifySource);
    if (cuts.status !== "available") return { status: "unavailable", reason: `Cut evidence: ${cuts.reason}` };
    const captions = await planCaptionGroups({ ...request.caption, snapshot, projectId: request.projectId, timelineId: request.timelineId,
      revision: request.revision, occurrenceId: request.occurrenceId }, request.speechRef, request.speechContext, artifacts, verifySource);
    if (captions.status !== "available") return { status: "unavailable", reason: `Caption evidence: ${captions.reason}` };
    const music = planMusic({ ...request.music, snapshot, projectId: request.projectId, timelineId: request.timelineId,
      revision: request.revision, brief: request.brief, accepted: request.accepted });
    const decisions: EditDecision[] = [
      ...cuts.plan.candidates.map((candidate): EditDecision => ({ kind: "cut", support: "unavailable", rationale: candidate.rationale, range: structuredClone(candidate.sequenceRange), candidate, analysisRef: structuredClone(cuts.analysisRef) })),
      ...captions.plan.groups.map((group): EditDecision => ({ kind: "caption", support: "unavailable", rationale: "Review mapped transcript text, timing and any emphasis before title placement.", range: structuredClone(group.sequenceRange), group, analysisRef: structuredClone(captions.plan.analysisRef) })),
      music.decision === "omit-music"
        ? { kind: "music-omission", support: "no-op", rationale: music.reason }
        : { kind: "music-proposal", support: "unavailable", rationale: music.reason, ...(music.placement ? { range: structuredClone(music.placement.range) } : {}) },
    ];
    decisions.sort((a, b) => ("range" in a ? a.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
      - ("range" in b ? b.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY));
    const content = { projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId,
      revision: structuredClone(request.revision), acceptedBrief: structuredClone(request.accepted), inputDigest: digest(request),
      reviewRequired: true as const, decisions, warnings: [...cuts.plan.warnings, ...captions.plan.warnings, ...music.warnings,
        "Native operation mapping, separate approval and independent verification are not yet available for these proposals."] };
    return { status: "available", plan: { ...content, planDigest: digest(content) } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Edit decision planning failed." };
  }
}

/** Recompute against current evidence; a matching plan is not execution authorization. */
export async function assertEditDecisionPlanCurrent(request: EditDecisionPlanRequest, plan: EditDecisionPlan, artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier): Promise<EditDecisionPlanValidity> {
  const current = await createEditDecisionPlan(request, artifacts, verifySource);
  if (current.status !== "available") return { status: "stale", reason: current.reason };
  return isDeepStrictEqual(current.plan, plan) ? { status: "current" } : { status: "stale", reason: "Plan inputs, decisions or digest changed." };
}
