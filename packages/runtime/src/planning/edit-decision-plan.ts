import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameAnalyzerDescriptor, sameMediaSourceIdentity } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { parseRational } from "../timeline/rational-time.js";
import { verifyAnalysisEvidence } from "./analysis-evidence.js";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";
import { planCaptionGroups } from "./caption-planning.js";
import type { CaptionGroup, CaptionPlanRequest } from "./caption-planning.js";
import { assertBriefBinding } from "./creative-brief.js";
import type { AcceptedCreativeBrief, CreativeBrief } from "./creative-brief.js";
import { planMusic } from "./music-planning.js";
import type { MusicPlan, MusicPlanRequest } from "./music-planning.js";
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
  speechRef?: AnalysisRef;
  vadRef?: AnalysisRef;
  speechContext?: AnalysisEvidenceContext;
  vadContext?: AnalysisEvidenceContext;
  caption: Omit<CaptionPlanRequest, "snapshot" | "projectId" | "timelineId" | "revision" | "occurrenceId">;
  music: Omit<MusicPlanRequest, "snapshot" | "projectId" | "timelineId" | "revision" | "brief" | "accepted">;
}
export type EditDecision =
  | { kind: "cut"; support: "unavailable"; rationale: string; range: TimeRange; candidate: NarrativeCutCandidate; analysisRef: AnalysisRef }
  | { kind: "caption"; support: "unavailable"; rationale: string; range: TimeRange; group: CaptionGroup; analysisRef: AnalysisRef }
  | { kind: "cut-unavailable"; support: "unavailable"; rationale: string }
  | { kind: "caption-unavailable"; support: "unavailable"; rationale: string }
  | { kind: "caption-omission"; support: "no-op"; rationale: string }
  | { kind: "caption-clarification"; support: "unavailable"; rationale: string }
  | { kind: "music-omission"; support: "no-op"; rationale: string; musicPlan: MusicPlan }
  | { kind: "music-proposal"; support: "unavailable"; rationale: string; musicPlan: MusicPlan; range?: TimeRange };
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
      || !sameRevision(snapshot.revision, request.revision)
      || Boolean(request.speechRef) !== Boolean(request.speechContext) || Boolean(request.vadRef) !== Boolean(request.vadContext)) {
      return { status: "unavailable", reason: "Target, revision or analysis reference pair is invalid." };
    }
    if (snapshot.timeline.frameGridOrigin && parseRational(snapshot.timeline.frameGridOrigin, "ANALYSIS_INVALID").value !== 0n) {
      return { status: "unavailable", reason: "Nonzero sequence frame-grid origins are not supported by the current planners." };
    }
    const clips = snapshot.timeline.clips.filter((clip) => clip.id === request.occurrenceId);
    const clip = clips.length === 1 ? clips[0] : undefined;
    const media = snapshot.media.filter((entry) => entry.mediaId === clip?.mediaId);
    const source = media.length === 1 ? media[0] : undefined;
    if (!clip || !source?.sourceDigest || !clip.startTime || !clip.durationTime || !snapshot.timeline.frameDuration
      || (clip.sourceStart !== undefined && clip.sourceStart !== 0 && !clip.sourceStartTime)) {
      return { status: "unavailable", reason: "Exact unique occurrence and source identity are required." };
    }
    const speechContext = request.speechContext;
    const vadContext = request.vadContext;
    if ((speechContext && (speechContext.kind !== "speech" || !sameRevision(speechContext.revision, request.revision) || !sameMediaSourceIdentity(source, speechContext.source)))
      || (vadContext && (vadContext.kind !== "vad" || !sameRevision(vadContext.revision, request.revision) || !sameMediaSourceIdentity(source, vadContext.source)))
      || (request.speechRef && request.speechRef.kind !== "speech") || (request.vadRef && request.vadRef.kind !== "vad")
      || (speechContext && vadContext && (!sameAnalyzerDescriptor(speechContext.provider, vadContext.provider)
        || request.speechRef!.artifactDigest !== request.vadRef!.artifactDigest))) {
      return { status: "unavailable", reason: "Current source, revision or speech/VAD identity conflicts." };
    }
    if (request.speechRef && speechContext) {
      const speechEvidence = await verifyAnalysisEvidence(artifacts, request.speechRef, speechContext, verifySource);
      if (speechEvidence.status !== "verified") return { status: "unavailable", reason: `Speech evidence: ${speechEvidence.reason}` };
    }
    const cutDecisions: EditDecision[] = [];
    const cutWarnings: string[] = [];
    if (!request.vadRef || !vadContext) {
      cutDecisions.push({ kind: "cut-unavailable", support: "unavailable", rationale: "Source-bound VAD evidence is unavailable; no cuts were proposed." });
    } else {
      const sourceStart = clip.sourceStart ?? 0;
      const sourceStartTime = clip.sourceStartTime ?? { value: "0", timescale: "1" };
      const cuts = await rankNarrativeCutsWithEvidence({ projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId,
        revision: request.revision, source: vadContext.source,
        sourceRange: { start: sourceStart, end: sourceStart + clip.duration, startTime: sourceStartTime, durationTime: clip.durationTime },
        sequenceRange: { start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime },
        sequenceFrameDuration: snapshot.timeline.frameDuration }, request.vadRef, vadContext, artifacts, verifySource);
      if (cuts.status !== "available") return { status: "unavailable", reason: `Cut evidence: ${cuts.reason}` };
      cutDecisions.push(...cuts.plan.candidates.map((candidate): EditDecision => ({ kind: "cut", support: "unavailable", rationale: candidate.rationale, range: structuredClone(candidate.sequenceRange), candidate, analysisRef: structuredClone(cuts.analysisRef) })));
      cutWarnings.push(...cuts.plan.warnings);
    }
    const captionPolicy = request.brief.captionPolicy;
    const policyValue = captionPolicy.kind === "specified" ? captionPolicy.value.trim().toLowerCase() : undefined;
    const captionDecisions: EditDecision[] = [];
    const captionWarnings: string[] = [];
    if (policyValue === "none") {
      captionDecisions.push({ kind: "caption-omission", support: "no-op", rationale: "The accepted brief explicitly requests no captions." });
    } else if (policyValue !== "basic") {
      captionDecisions.push({ kind: "caption-clarification", support: "unavailable", rationale: "Caption preference requires clarification before proposing titles." });
    } else if (!request.speechRef || !speechContext) {
      captionDecisions.push({ kind: "caption-unavailable", support: "unavailable", rationale: "Source-bound transcript evidence is unavailable; no captions were proposed." });
    } else {
      const captions = await planCaptionGroups({ ...request.caption, snapshot, projectId: request.projectId, timelineId: request.timelineId,
        revision: request.revision, occurrenceId: request.occurrenceId }, request.speechRef, speechContext, artifacts, verifySource);
      if (captions.status !== "available") return { status: "unavailable", reason: `Caption evidence: ${captions.reason}` };
      captionDecisions.push(...captions.plan.groups.map((group): EditDecision => ({ kind: "caption", support: "unavailable", rationale: "Review mapped transcript text, timing and any emphasis before title placement.", range: structuredClone(group.sequenceRange), group, analysisRef: structuredClone(captions.plan.analysisRef) })));
      captionWarnings.push(...captions.plan.warnings);
    }
    const music = planMusic({ ...request.music, snapshot, projectId: request.projectId, timelineId: request.timelineId,
      revision: request.revision, brief: request.brief, accepted: request.accepted });
    const decisions: EditDecision[] = [
      ...cutDecisions,
      ...captionDecisions,
      music.decision === "omit-music"
        ? { kind: "music-omission", support: "no-op", rationale: music.reason, musicPlan: music }
        : { kind: "music-proposal", support: "unavailable", rationale: music.reason, musicPlan: music, ...(music.placement ? { range: structuredClone(music.placement.range) } : {}) },
    ];
    decisions.sort((a, b) => ("range" in a ? a.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
      - ("range" in b ? b.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY));
    const content = { projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId,
      revision: structuredClone(request.revision), acceptedBrief: structuredClone(request.accepted), inputDigest: digest(request),
      reviewRequired: true as const, decisions, warnings: [...cutWarnings, ...captionWarnings, ...music.warnings,
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
