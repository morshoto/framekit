import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertCurrentAcceptedBrief } from "../application/creative-brief-store.js";
import type { CreativeBriefStore } from "../application/creative-brief-store.js";
import { validateAudioAnalysisRange } from "../audio/analysis.js";
import type { CompositeEditPreview, MusicAddRequest } from "../domain/editing.js";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaSourceIdentity, SpeechOccurrenceMapping } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { assertBriefBinding, assertBriefSourceCoverage } from "./creative-brief.js";
import type { AcceptedCreativeBrief, CreativeBrief } from "./creative-brief.js";

export interface MusicPlanRequest {
  brief: CreativeBrief;
  accepted: AcceptedCreativeBrief;
  snapshot: ProjectSnapshot;
  projectId: string;
  occurrenceId: string;
  timelineId: string;
  revision: ContextRevision;
  music?: MediaSourceIdentity;
  placement: TimeRange;
  gainDb?: number;
  targetLane: number;
  context: { speech: "present" | "absent" | "unknown"; audioEvidence: "available" | "unavailable" };
  /** Caller-supplied mapping; provenance and source bytes are not verified here. */
  speechMapping?: SpeechOccurrenceMapping;
  capabilities: { staticMusicPreview: boolean; ducking: boolean; fades: boolean };
  requestedDucking?: boolean;
  requestedFades?: boolean;
}

export interface MusicPlan {
  inputDigest: string;
  decision: "propose-music" | "omit-music" | "needs-review" | "unavailable" | "unsupported";
  projectId: string;
  timelineId: string;
  revision: ContextRevision;
  brief: AcceptedCreativeBrief;
  reviewRequired: true;
  reason: string;
  warnings: string[];
  dialogueVerificationRequired: boolean;
  /** A proposed static music level, not proof that dialogue will be audible. */
  dialogueProtection?: {
    range: TimeRange;
    musicGainDb: number;
    sourceAudio: "unchanged";
    speechContext: "present" | "absent" | "unknown";
    speechContextVerification: "unverified";
    audibility: "unverified";
    speechOverlap?: { occurrenceId: string; coverage: "complete" | "unknown"; ranges: TimeRange[]; verification: "unverified" };
  };
  placement?: { occurrenceId: string; mediaId: string; sourceDigest: string; range: TimeRange; sourceRange: TimeRange; targetLane: number; gainDb: number };
}

/** Create a proposal only; preview, approval and audio verification are separate operations. */
export function planMusic(request: MusicPlanRequest): MusicPlan {
  assertBriefBinding(request.accepted, request.brief);
  const actual = request.snapshot;
  if (!actual || request.projectId !== actual.projectId || request.timelineId !== actual.timeline?.id
    || request.revision.id !== actual.revision?.id || request.revision.sequence !== actual.revision?.sequence
    || request.revision.timestamp !== actual.revision?.timestamp) throw new Error("STALE_CONTEXT: project, timeline or revision differs from current snapshot");
  if (!["present", "absent", "unknown"].includes(request.context?.speech)
    || !["available", "unavailable"].includes(request.context?.audioEvidence)) throw new Error("INVALID_MUSIC_PLAN: audio context must be explicit");
  const encoded = JSON.stringify(request, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  const inputDigest = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
  const base = { inputDigest, projectId: request.projectId, timelineId: request.timelineId, revision: structuredClone(request.revision), brief: structuredClone(request.accepted), reviewRequired: true as const, warnings: [] as string[], dialogueVerificationRequired: false };
  const policy = request.brief.musicPolicy;
  if (policy.kind === "no-preference") return { ...base, decision: "needs-review", reason: "Music preference was not specified; review whether music is appropriate." };
  const value = policy.value.trim().toLowerCase();
  if (value === "none") return { ...base, decision: "omit-music", reason: "The accepted brief explicitly requests no music." };
  if (value !== "background") return { ...base, decision: "needs-review", reason: "The music policy needs a concrete placement decision." };
  if (request.requestedDucking || request.requestedFades) return { ...base, decision: "unsupported", reason: "Requested dynamic mixing or transitions require a separately supported workflow." };
  if (!request.capabilities?.staticMusicPreview) return { ...base, decision: "unsupported", reason: "Static music placement preview is unavailable for this target." };
  const music = request.music;
  const registered = music ? actual.media.filter((media) => media.mediaId === music.mediaId) : [];
  if (!music?.sourceDigest || !music.mediaId || !music.source || music.mediaKind !== "audio" || !Number.isFinite(music.duration) || !music.duration || music.duration <= 0
    || registered.length !== 1 || !sameMediaSourceIdentity(registered[0]!, music)) {
    return { ...base, decision: "unavailable", reason: "A unique, exactly matching registered music source is required." };
  }
  const range = request.placement;
  if (!request.occurrenceId?.trim() || actual.timeline.clips.some((clip) => clip.id === request.occurrenceId)) return { ...base, decision: "unsupported", reason: "A new music occurrence identity is required." };
  try { validateAudioAnalysisRange(range, "music placement"); } catch { return { ...base, decision: "unsupported", reason: "Music placement timing is invalid or inconsistent." }; }
  if (!range || !Number.isFinite(actual.timeline.duration) || actual.timeline.duration <= 0 || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start
    || range.end > actual.timeline.duration || range.end - range.start > music.duration
    || !Number.isInteger(request.targetLane) || request.targetLane === 0) {
    return { ...base, decision: "unsupported", reason: "The requested range or lane is outside supported static placement." };
  }
  if (request.gainDb === undefined) return { ...base, decision: "needs-review", reason: "An explicit music gain is required for review." };
  if (!Number.isFinite(request.gainDb) || request.gainDb > 0) return { ...base, decision: "unsupported", reason: "The requested music gain is invalid or amplifies the source." };
  const speechOverlap = request.speechMapping ? reviewSpeechOverlap(request.speechMapping, actual, range) : undefined;
  const warnings = ["Verify rendered dialogue audibility and the resulting mix after any separately approved edit."];
  if (request.context.audioEvidence === "unavailable") warnings.push("Audio analysis is unavailable; no mix quality is inferred.");
  else warnings.push("Supplied audio context is unverified by this music planner; no mix quality is inferred.");
  if (request.context.speech === "unknown") warnings.push("Speech presence is unknown; preserve the source mix until reviewed.");
  if (speechOverlap) warnings.push("Speech overlap is derived from a caller-supplied mapping and is not independently verified.");
  return {
    ...base, decision: "propose-music", reason: "The accepted brief requests a background music proposal.", warnings,
    dialogueVerificationRequired: true,
    dialogueProtection: { range: structuredClone(range), musicGainDb: request.gainDb, sourceAudio: "unchanged",
      speechContext: request.context.speech, speechContextVerification: "unverified", audibility: "unverified", ...(speechOverlap ? { speechOverlap } : {}) },
    placement: { occurrenceId: request.occurrenceId, mediaId: music.mediaId, sourceDigest: music.sourceDigest, range: structuredClone(range), sourceRange: { start: 0, end: range.end - range.start }, targetLane: request.targetLane, gainDb: request.gainDb },
  };
}

function reviewSpeechOverlap(mapping: SpeechOccurrenceMapping, snapshot: ProjectSnapshot, placement: TimeRange): NonNullable<NonNullable<MusicPlan["dialogueProtection"]>["speechOverlap"]> {
  const clips = snapshot.timeline.clips.filter((clip) => clip.id === mapping.occurrenceId);
  const clip = clips.length === 1 ? clips[0] : undefined;
  const sourceStart = clip?.sourceStart ?? 0;
  if (!clip || !clip.mediaId || clip.mediaId !== mapping.mediaId || snapshot.media.filter((source) => source.mediaId === mapping.mediaId).length !== 1
    || mapping.revision?.id !== snapshot.revision.id || mapping.revision?.sequence !== snapshot.revision.sequence || mapping.revision?.timestamp !== snapshot.revision.timestamp
    || mapping.sourceRange?.start !== sourceStart || mapping.sourceRange?.end !== sourceStart + clip.duration
    || mapping.sequenceRange?.start !== clip.start || mapping.sequenceRange?.end !== clip.start + clip.duration) {
    throw new Error("STALE_MUSIC_PLAN: speech mapping does not match the current occurrence");
  }
  const ranges: TimeRange[] = [];
  let cursor = placement.start;
  let previousEnd = clip.start;
  const sameTime = (left: number, right: number) => Math.abs(left - right) <= 0.000000001;
  for (const span of mapping.vadCoverage ?? []) {
    validateAudioAnalysisRange(span.sequenceRange, "speech coverage");
    validateAudioAnalysisRange(span.sourceRange, "speech source coverage");
    const offset = clip.start - sourceStart;
    if (!sameTime(span.sequenceRange.start, span.sourceRange.start + offset) || !sameTime(span.sequenceRange.end, span.sourceRange.end + offset)
      || span.sequenceRange.start < previousEnd || span.sequenceRange.end > clip.start + clip.duration) throw new Error("INVALID_MUSIC_PLAN: speech coverage does not match the occurrence");
    previousEnd = span.sequenceRange.end;
    if (span.status === "available") {
      for (const segment of span.segments) {
        validateAudioAnalysisRange(segment.sequenceRange, "speech segment");
        validateAudioAnalysisRange(segment.sourceRange, "speech source segment");
        if (!["speech", "silence", "breath", "laughter", "noise"].includes(segment.segment.kind) || segment.segment.start !== segment.sourceRange.start || segment.segment.end !== segment.sourceRange.end
          || !sameTime(segment.sequenceRange.start, segment.sourceRange.start + offset) || !sameTime(segment.sequenceRange.end, segment.sourceRange.end + offset)
          || segment.sequenceRange.start < span.sequenceRange.start || segment.sequenceRange.end > span.sequenceRange.end) throw new Error("INVALID_MUSIC_PLAN: speech segment exceeds or conflicts with coverage");
        const start = Math.max(placement.start, segment.sequenceRange.start);
        const end = Math.min(placement.end, segment.sequenceRange.end);
        if (segment.segment.kind === "speech" && start < end) ranges.push({ start, end });
      }
      if (span.sequenceRange.start <= cursor && span.sequenceRange.end > cursor) cursor = span.sequenceRange.end;
    }
  }
  return { occurrenceId: mapping.occurrenceId, coverage: cursor >= placement.end ? "complete" : "unknown", ranges, verification: "unverified" };
}

export interface MusicPreviewPort {
  inspectProject(): Promise<ProjectSnapshot>;
  previewMusic(request: MusicAddRequest): Promise<CompositeEditPreview>;
}

/** Review-only projection; execution requires a separately authorized workflow. */
export type MusicPlanPreview = Omit<CompositeEditPreview, "previewToken">;

/** Recompute the reviewed proposal against live context, then use the existing preview path. */
export async function previewMusicPlan(
  runtime: MusicPreviewPort,
  request: MusicPlanRequest,
  reviewed: MusicPlan,
  occurrenceId: string,
  verifySource: (source: MediaSourceIdentity) => Promise<void>,
  briefStore: CreativeBriefStore,
): Promise<MusicPlanPreview> {
  request = structuredClone(request);
  reviewed = structuredClone(reviewed);
  if (typeof verifySource === "function") {
    const delegate = verifySource;
    verifySource = (source) => delegate(structuredClone(source));
  }
  if (!occurrenceId?.trim() || occurrenceId !== request.occurrenceId) throw new Error("INVALID_MUSIC_PLAN: reviewed occurrence identity is required");
  if (!briefStore) throw new Error("CAPABILITY_UNAVAILABLE: authoritative brief store is required");
  await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
  const current = structuredClone(await runtime.inspectProject());
  assertBriefSourceCoverage(request.accepted, request.brief, current.media);
  if (typeof verifySource !== "function") throw new Error("CAPABILITY_UNAVAILABLE: source verification is required");
  for (const id of new Set(request.brief.sourceCoverage.map((coverage) => coverage.sourceId))) {
    await verifySource(current.media.find((source) => source.mediaId === id)!);
  }
  const recomputed = planMusic({ ...request, snapshot: current });
  if (recomputed.decision !== "propose-music" || !recomputed.placement || !isDeepStrictEqual(recomputed, reviewed)) {
    throw new Error("STALE_MUSIC_PLAN: reviewed proposal no longer matches current inputs");
  }
  if (typeof verifySource !== "function" || !request.music) throw new Error("CAPABILITY_UNAVAILABLE: music source verification is required");
  await verifySource(request.music);
  const preview = structuredClone(await runtime.previewMusic({
    baseRevision: structuredClone(recomputed.revision), occurrenceId, mediaId: recomputed.placement.mediaId,
    placement: "insert", start: recomputed.placement.range.start,
    duration: recomputed.placement.range.end - recomputed.placement.range.start,
    targetLane: recomputed.placement.targetLane, gainDb: recomputed.placement.gainDb,
  }));
  if (preview.target.kind !== "editor.timeline" || preview.target.projectId !== request.projectId
    || preview.target.sequenceId !== request.timelineId || !isDeepStrictEqual(preview.baseRevision, recomputed.revision)) {
    throw new Error("STALE_MUSIC_PREVIEW: preview target or revision differs from the reviewed proposal");
  }
  const expectedOperations = [
    { type: "timeline.media.add", occurrenceId, mediaId: recomputed.placement.mediaId, role: "music", start: recomputed.placement.range.start,
      duration: recomputed.placement.range.end - recomputed.placement.range.start, targetLane: recomputed.placement.targetLane },
    { type: "set-gain", clipId: occurrenceId, gainDb: recomputed.placement.gainDb },
  ];
  if (!isDeepStrictEqual(preview.operations, expectedOperations)) {
    throw new Error("MUSIC_PREVIEW_MISMATCH: operations differ from the reviewed proposal");
  }
  await verifySource(request.music);
  const after = structuredClone(await runtime.inspectProject());
  assertBriefSourceCoverage(request.accepted, request.brief, after.media);
  for (const id of new Set(request.brief.sourceCoverage.map((coverage) => coverage.sourceId))) {
    await verifySource(after.media.find((source) => source.mediaId === id)!);
  }
  const finalPlan = planMusic({ ...request, snapshot: after });
  if (!isDeepStrictEqual(finalPlan, reviewed)) throw new Error("STALE_MUSIC_PLAN: project changed during preview");
  await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
  const { previewToken: _editorToken, ...review } = preview;
  return review;
}
