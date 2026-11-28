import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameAnalyzerDescriptor, sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaSourceIdentity, MediaUnderstanding, SpeechOccurrenceMapping } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";
import { mapSpeechAnalysisToOccurrence } from "../speech/mapping.js";
import { assertCurrentAcceptedBrief } from "../application/creative-brief-store.js";
import type { CreativeBriefStore } from "../application/creative-brief-store.js";
import { parseRational } from "../timeline/rational-time.js";
import { verifyAnalysisEvidence } from "./analysis-evidence.js";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";
import { planCaptionGroups } from "./caption-planning.js";
import type { CaptionGroup, CaptionPlanRequest } from "./caption-planning.js";
import { assertBriefBinding, assertBriefSourceCoverage } from "./creative-brief.js";
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
  audioRef?: AnalysisRef;
  speechContext?: AnalysisEvidenceContext;
  vadContext?: AnalysisEvidenceContext;
  audioContext?: AnalysisEvidenceContext;
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
  | { kind: "music-omission"; support: "no-op"; rationale: string; musicPlan: MusicPlan; audioRef?: AnalysisRef }
  | { kind: "music-proposal"; support: "unavailable"; rationale: string; musicPlan: MusicPlan; range?: TimeRange; audioRef?: AnalysisRef; vadRef?: AnalysisRef };
export interface EditDecisionPlan {
  projectId: string;
  timelineId: string;
  occurrenceId: string;
  source: MediaSourceIdentity;
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

type CoverageFraction = { value: bigint; timescale: bigint };
function coverageCompare(a: CoverageFraction, b: CoverageFraction): number {
  const delta = a.value * b.timescale - b.value * a.timescale;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
function coverageAdd(a: CoverageFraction, b: CoverageFraction): CoverageFraction {
  return { value: a.value * b.timescale + b.value * a.timescale, timescale: a.timescale * b.timescale };
}
function coverageDecimal(n: number): CoverageFraction {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!match) throw new Error("invalid coverage time");
  const value = BigInt(match[1]! + (match[2] ?? ""));
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  return exponent >= 0 ? { value: value * 10n ** BigInt(exponent), timescale: 1n }
    : { value, timescale: 10n ** BigInt(-exponent) };
}

/** Withhold cuts unless every removed required source interval survives elsewhere. */
function preservesRequiredCoverage(candidate: NarrativeCutCandidate, request: EditDecisionPlanRequest, source: MediaSourceIdentity): boolean {
  const required = request.brief.sourceCoverage.filter((item) => item.sourceId === source.mediaId);
  if (!required.length) return true;
  try {
    const fraction = (time: NonNullable<TimeRange["startTime"]>) => parseRational(time, "COVERAGE_UNAVAILABLE");
    if (!candidate.sourceRange.startTime || !candidate.sourceRange.durationTime) return false;
    const cutStart = fraction(candidate.sourceRange.startTime);
    const cutEnd = coverageAdd(cutStart, fraction(candidate.sourceRange.durationTime));
    for (const requirement of required) {
      const start = coverageDecimal(requirement.start); const end = coverageDecimal(requirement.end);
      const removedStart = coverageCompare(cutStart, start) > 0 ? cutStart : start;
      const removedEnd = coverageCompare(cutEnd, end) < 0 ? cutEnd : end;
      if (coverageCompare(removedStart, removedEnd) >= 0) continue;
      const timelineEnd = request.snapshot.timeline.durationTime;
      if (!timelineEnd) return false;
      const sequenceEnd = fraction(timelineEnd);
      const ids = request.snapshot.timeline.clips.map((clip) => clip.id);
      if (new Set(ids).size !== ids.length) return false;
      const selected = request.snapshot.timeline.clips.find((clip) => clip.id === candidate.occurrenceId);
      if (!selected?.role || (selected.role !== "video" && selected.role !== "audio")) return false;
      const retained = request.snapshot.timeline.clips.flatMap((clip) => {
        if (clip.id === candidate.occurrenceId || clip.mediaId !== source.mediaId || clip.enabled === false || clip.role !== selected.role
          || !clip.startTime || !clip.durationTime || (!clip.sourceStartTime && (clip.sourceStart ?? 0) !== 0)) return [];
        try {
          const sequenceStart = fraction(clip.startTime); const duration = fraction(clip.durationTime);
          if (sequenceStart.value < 0n || duration.value <= 0n || coverageCompare(coverageAdd(sequenceStart, duration), sequenceEnd) > 0) return [];
          const sourceStart = fraction(clip.sourceStartTime ?? { value: "0", timescale: "1" });
          return [{ start: sourceStart, end: coverageAdd(sourceStart, duration) }];
        } catch { return []; }
      }).sort((a, b) => coverageCompare(a.start, b.start));
      let cursor = removedStart;
      for (const range of retained) {
        if (coverageCompare(range.end, cursor) <= 0) continue;
        if (coverageCompare(range.start, cursor) > 0) break;
        cursor = range.end;
        if (coverageCompare(cursor, removedEnd) >= 0) break;
      }
      if (coverageCompare(cursor, removedEnd) < 0) return false;
    }
    return true;
  } catch { return false; }
}
function digest(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

/** Check that the plan content matches its digest; this does not authenticate approval. */
export function hasValidEditDecisionPlanDigest(plan: EditDecisionPlan): boolean {
  try {
    if (!plan || typeof plan !== "object" || typeof plan.planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(plan.planDigest)) return false;
    const { planDigest, ...content } = plan;
    return digest(content) === planDigest;
  } catch { return false; }
}

/** Integrate verified proposals without executing or silently switching editor backends. */
export async function createEditDecisionPlan(request: EditDecisionPlanRequest, artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier, briefStore: CreativeBriefStore): Promise<EditDecisionPlanResult> {
  try {
    request = structuredClone(request);
    if (typeof verifySource === "function") {
      const delegate = verifySource;
      verifySource = (source) => delegate(structuredClone(source));
    }
    if (!briefStore) return { status: "unavailable", reason: "Authoritative creative brief store is required." };
    assertBriefBinding(request.accepted, request.brief);
    await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
    const snapshot = request.snapshot;
    if (!snapshot || snapshot.projectId !== request.projectId || snapshot.timeline.id !== request.timelineId
      || !sameRevision(snapshot.revision, request.revision)
      || Boolean(request.speechRef) !== Boolean(request.speechContext) || Boolean(request.vadRef) !== Boolean(request.vadContext)
      || Boolean(request.audioRef) !== Boolean(request.audioContext)) {
      return { status: "unavailable", reason: "Target, revision or analysis reference pair is invalid." };
    }
    assertBriefSourceCoverage(request.accepted, request.brief, snapshot.media);
    if (typeof verifySource !== "function") return { status: "unavailable", reason: "Source verification is required." };
    const coveredSources = [...new Set(request.brief.sourceCoverage.map((coverage) => coverage.sourceId))]
      .map((id) => snapshot.media.find((source) => source.mediaId === id)!);
    for (const source of coveredSources) await verifySource(source);
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
    if (request.audioRef && request.audioContext) {
      const audio = request.audioContext;
      const sourceStart = clip.sourceStart ?? 0;
      if (audio.kind !== "audio" || !sameRevision(audio.revision, request.revision)
        || !sameMediaSourceIdentity(source, audio.source) || audio.range.start > sourceStart
        || audio.range.end < sourceStart + clip.duration) {
        return { status: "unavailable", reason: "Audio evidence does not cover the current source occurrence." };
      }
      const evidence = await verifyAnalysisEvidence(artifacts, request.audioRef, audio, verifySource);
      if (evidence.status !== "verified") return { status: "unavailable", reason: `Audio evidence: ${evidence.reason}` };
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
      const safe = cuts.plan.candidates.filter((candidate) => preservesRequiredCoverage(candidate, request, source));
      if (safe.length !== cuts.plan.candidates.length) cutWarnings.push("Some cut candidates were withheld because required source coverage would be lost or could not be verified.");
      if (!safe.length && cuts.plan.candidates.length) cutDecisions.push({ kind: "cut-unavailable", support: "unavailable", rationale: "No candidate preserves verified required source coverage." });
      cutDecisions.push(...safe.map((candidate): EditDecision => ({ kind: "cut", support: "unavailable", rationale: candidate.rationale, range: structuredClone(candidate.sequenceRange), candidate, analysisRef: structuredClone(cuts.analysisRef) })));
      cutWarnings.push(...cuts.plan.warnings);
    }
    const captionPolicy = request.brief.captionPolicy;
    const policyValue = captionPolicy.kind === "specified" ? captionPolicy.value.trim().toLowerCase() : undefined;
    if (request.caption.wordCorrections?.length && (policyValue !== "basic" || !request.speechRef || !speechContext)) {
      return { status: "unavailable", reason: "Caption corrections require a basic caption plan and pinned speech evidence." };
    }
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
    let pinnedMusicSpeech: SpeechOccurrenceMapping | undefined;
    if (request.vadRef && vadContext && request.brief.musicPolicy.kind === "specified"
      && request.brief.musicPolicy.value.trim().toLowerCase() === "background" && request.music.music) {
      const verified = await verifyAnalysisEvidence(artifacts, request.vadRef, vadContext, verifySource);
      if (verified.status !== "verified") return { status: "unavailable", reason: `Music VAD evidence: ${verified.reason}` };
      const bytes = await artifacts.get(request.vadRef.artifactDigest);
      if (!bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== request.vadRef.artifactDigest) return { status: "unavailable", reason: "Music VAD artifact changed or disappeared." };
      const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as MediaUnderstanding;
      if (!record.speech) return { status: "unavailable", reason: "Music VAD artifact is missing speech analysis." };
      const bound = bindSpeechAnalysis(record.speech, { input: { project: { ...snapshot, revision: request.vadRef.analysisRevision }, media: source }, provider: vadContext.provider });
      const vadCoverage = bound.vadCoverage ?? (bound.vadSegments ? [{ ...bound.observedRange, status: "available" as const, segments: bound.vadSegments }] : undefined);
      const sourceStart = clip.sourceStart ?? 0;
      pinnedMusicSpeech = mapSpeechAnalysisToOccurrence({ ...bound, revision: structuredClone(request.revision), ...(vadCoverage ? { vadCoverage } : {}) }, {
        occurrenceId: clip.id, mediaId: source.mediaId, revision: request.revision,
        sourceRange: { start: sourceStart, end: sourceStart + clip.duration, startTime: clip.sourceStartTime ?? { value: "0", timescale: "1" }, durationTime: clip.durationTime },
        sequenceRange: { start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime },
      }, { sequenceFrameDuration: snapshot.timeline.frameDuration });
      await verifySource(source);
    }
    const music = planMusic({ ...request.music, ...(pinnedMusicSpeech ? { speechMapping: pinnedMusicSpeech } : {}), snapshot, projectId: request.projectId, timelineId: request.timelineId,
      revision: request.revision, brief: request.brief, accepted: request.accepted });
    const decisions: EditDecision[] = [
      ...cutDecisions,
      ...captionDecisions,
      music.decision === "omit-music"
        ? { kind: "music-omission", support: "no-op", rationale: music.reason, musicPlan: music, ...(request.audioRef ? { audioRef: structuredClone(request.audioRef) } : {}) }
        : { kind: "music-proposal", support: "unavailable", rationale: music.reason, musicPlan: music, ...(request.audioRef ? { audioRef: structuredClone(request.audioRef) } : {}), ...(pinnedMusicSpeech && request.vadRef ? { vadRef: structuredClone(request.vadRef) } : {}), ...(music.placement ? { range: structuredClone(music.placement.range) } : {}) },
    ];
    decisions.sort((a, b) => ("range" in a ? a.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
      - ("range" in b ? b.range?.start ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY));
    const sourceIdentity: MediaSourceIdentity = { mediaId: source.mediaId, source: source.source, sourceDigest: source.sourceDigest,
      ...(source.mediaKind !== undefined ? { mediaKind: source.mediaKind } : {}), ...(source.duration !== undefined ? { duration: source.duration } : {}) };
    const content = { projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId, source: sourceIdentity,
      revision: structuredClone(request.revision), acceptedBrief: structuredClone(request.accepted), inputDigest: digest(request),
      reviewRequired: true as const, decisions, warnings: [...cutWarnings, ...captionWarnings, ...music.warnings,
        ...(pinnedMusicSpeech ? ["Music speech overlap is derived from pinned VAD; audibility remains unverified."] : []),
        ...(request.music.context.audioEvidence === "available" && !request.audioRef ? ["Supplied audio context is unverified because no pinned audio reference was provided."] : []),
        ...(request.audioRef ? ["Source audio evidence does not verify the edited mix or dialogue audibility; supplied speech context is not derived from this evidence."] : []),
        "Native operation mapping, separate approval and independent verification are not yet available for these proposals."] };
    for (const source of coveredSources) await verifySource(source);
    if (request.audioRef && request.audioContext) {
      const evidence = await verifyAnalysisEvidence(artifacts, request.audioRef, request.audioContext, verifySource);
      if (evidence.status !== "verified") return { status: "unavailable", reason: `Audio evidence: ${evidence.reason}` };
    }
    await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
    for (const [label, ref, context] of [
      ["Speech", request.speechRef, request.speechContext],
      ["VAD", request.vadRef, request.vadContext],
      ["Audio", request.audioRef, request.audioContext],
    ] as const) {
      if (!ref || !context) continue;
      const evidence = await verifyAnalysisEvidence(artifacts, ref, context, verifySource);
      if (evidence.status !== "verified") return { status: "unavailable", reason: `${label} evidence: ${evidence.reason}` };
    }
    await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
    return { status: "available", plan: { ...content, planDigest: digest(content) } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Edit decision planning failed." };
  }
}

/** Recompute against current evidence; a matching plan is not execution authorization. */
export async function assertEditDecisionPlanCurrent(request: EditDecisionPlanRequest, plan: EditDecisionPlan, artifacts: AnalysisArtifactStore, verifySource: AnalysisSourceVerifier, briefStore: CreativeBriefStore): Promise<EditDecisionPlanValidity> {
  let expected: EditDecisionPlan;
  try { expected = structuredClone(plan); }
  catch { return { status: "stale", reason: "Plan cannot be safely inspected." }; }
  const current = await createEditDecisionPlan(request, artifacts, verifySource, briefStore);
  if (current.status !== "available") return { status: "stale", reason: current.reason };
  return isDeepStrictEqual(current.plan, expected) ? { status: "current" } : { status: "stale", reason: "Plan inputs, decisions or digest changed." };
}
