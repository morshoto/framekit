import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertCurrentAcceptedBrief } from "../application/creative-brief-store.js";
import type { CreativeBriefStore } from "../application/creative-brief-store.js";
import { validateAudioAnalysisRange } from "../audio/analysis.js";
import type { CompositeEditPreview, MusicAddRequest } from "../domain/editing.js";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaSourceIdentity } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { assertBriefBinding } from "./creative-brief.js";
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
  if (!music?.sourceDigest || !music.mediaId || !music.source || music.mediaKind !== "audio" || !Number.isFinite(music.duration) || !music.duration || music.duration <= 0
    || !actual.media.some((media) => sameMediaSourceIdentity(media, music))) {
    return { ...base, decision: "unavailable", reason: "An exactly matching registered music source is required." };
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
  const warnings = ["Verify rendered dialogue audibility and the resulting mix after any separately approved edit."];
  if (request.context.audioEvidence === "unavailable") warnings.push("Audio analysis is unavailable; no mix quality is inferred.");
  if (request.context.speech === "unknown") warnings.push("Speech presence is unknown; preserve the source mix until reviewed.");
  return {
    ...base, decision: "propose-music", reason: "The accepted brief requests a background music proposal.", warnings,
    dialogueVerificationRequired: true,
    placement: { occurrenceId: request.occurrenceId, mediaId: music.mediaId, sourceDigest: music.sourceDigest, range: structuredClone(range), sourceRange: { start: 0, end: range.end - range.start }, targetLane: request.targetLane, gainDb: request.gainDb },
  };
}

export interface MusicPreviewPort {
  inspectProject(): Promise<ProjectSnapshot>;
  previewMusic(request: MusicAddRequest): Promise<CompositeEditPreview>;
}

/** Recompute the reviewed proposal against live context, then use the existing preview path. */
export async function previewMusicPlan(
  runtime: MusicPreviewPort,
  request: MusicPlanRequest,
  reviewed: MusicPlan,
  occurrenceId: string,
  verifySource: (source: MediaSourceIdentity) => Promise<void>,
  briefStore: CreativeBriefStore,
): Promise<CompositeEditPreview> {
  if (!occurrenceId?.trim() || occurrenceId !== request.occurrenceId) throw new Error("INVALID_MUSIC_PLAN: reviewed occurrence identity is required");
  if (!briefStore) throw new Error("CAPABILITY_UNAVAILABLE: authoritative brief store is required");
  await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
  const current = await runtime.inspectProject();
  const recomputed = planMusic({ ...request, snapshot: current });
  if (recomputed.decision !== "propose-music" || !recomputed.placement || !isDeepStrictEqual(recomputed, reviewed)) {
    throw new Error("STALE_MUSIC_PLAN: reviewed proposal no longer matches current inputs");
  }
  if (typeof verifySource !== "function" || !request.music) throw new Error("CAPABILITY_UNAVAILABLE: music source verification is required");
  await verifySource(request.music);
  const preview = await runtime.previewMusic({
    baseRevision: structuredClone(recomputed.revision), occurrenceId, mediaId: recomputed.placement.mediaId,
    placement: "insert", start: recomputed.placement.range.start,
    duration: recomputed.placement.range.end - recomputed.placement.range.start,
    targetLane: recomputed.placement.targetLane, gainDb: recomputed.placement.gainDb,
  });
  await verifySource(request.music);
  await assertCurrentAcceptedBrief(briefStore, request.projectId, request.accepted);
  return preview;
}
