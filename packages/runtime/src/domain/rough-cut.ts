import type { ContextRevision } from "./primitives.js";
import type { CompositeEditPreview, ImportMediaOperation, WorkflowOperation } from "./editing.js";
import type { MediaContext } from "./media.js";
import type { ProjectSnapshot } from "./project.js";

export interface RoughCutShot {
  occurrenceId: string;
  mediaId: string;
  duration?: number;
}

export interface RoughCutPlanRequest {
  baseRevision: ContextRevision;
  imports?: ImportMediaOperation[];
  shots: RoughCutShot[];
}

export interface RoughCutPlan {
  projectId: string;
  timelineId: string;
  baseRevision: ContextRevision;
  operations: WorkflowOperation[];
  duration: number;
}

export interface RoughCutPreview extends CompositeEditPreview {
  plan: RoughCutPlan;
}

/** Build a deterministic primary-storyline workflow without mutating a project. */
export function planRoughCut(snapshot: ProjectSnapshot, request: RoughCutPlanRequest): RoughCutPlan {
  assertRevision(snapshot.revision, request.baseRevision);
  if (request.shots.length === 0) throw new Error("INVALID_ROUGH_CUT: at least one shot is required");

  const imports = request.imports ?? [];
  const knownMedia = new Map(snapshot.media.map((media) => [media.mediaId, media]));
  const importedIds = new Set<string>();
  for (const media of imports) {
    if (importedIds.has(media.mediaId) || knownMedia.has(media.mediaId)) {
      throw new Error(`MEDIA_ALREADY_EXISTS: ${media.mediaId}`);
    }
    if (!media.mediaId.trim() || !media.source.trim() || !media.sourceDigest.trim()
      || !Number.isFinite(media.duration) || media.duration <= 0) {
      throw new Error("INVALID_OPERATION: imported media requires mediaId, source, duration, and digest");
    }
    if (media.mediaKind !== "video") {
      throw new Error(`ROUGH_CUT_VIDEO_REQUIRED: ${media.mediaId}`);
    }
    importedIds.add(media.mediaId);
    knownMedia.set(media.mediaId, media);
  }

  const occurrenceIds = new Set(snapshot.timeline.clips.map((clip) => clip.id));
  const operations: WorkflowOperation[] = imports.map((media) => ({ ...media }));
  let start = snapshot.timeline.duration;
  for (const shot of request.shots) {
    if (!shot.occurrenceId.trim() || !shot.mediaId.trim()) {
      throw new Error("INVALID_ROUGH_CUT: shot occurrenceId and mediaId are required");
    }
    if (occurrenceIds.has(shot.occurrenceId)) {
      throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${shot.occurrenceId}`);
    }
    occurrenceIds.add(shot.occurrenceId);

    const media = knownMedia.get(shot.mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${shot.mediaId}`);
    if (media.mediaKind !== "video") throw new Error(`ROUGH_CUT_VIDEO_REQUIRED: ${shot.mediaId}`);
    const duration = shot.duration ?? media.duration;
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(`ROUGH_CUT_DURATION_REQUIRED: ${shot.mediaId}`);
    }
    if (media.duration !== undefined && duration > media.duration) {
      throw new Error(`ROUGH_CUT_DURATION_EXCEEDS_SOURCE: ${shot.mediaId}`);
    }
    operations.push({
      type: "timeline.media.add",
      occurrenceId: shot.occurrenceId,
      mediaId: shot.mediaId,
      role: "video",
      start,
      duration,
      targetLane: "primary",
    });
    start += duration;
  }

  return {
    projectId: snapshot.projectId,
    timelineId: snapshot.timeline.id,
    baseRevision: structuredClone(request.baseRevision),
    operations,
    duration: start,
  };
}

function assertRevision(actual: ContextRevision, expected: ContextRevision): void {
  if (actual.id !== expected.id || actual.sequence !== expected.sequence) {
    throw new Error("STALE_CONTEXT: rough-cut plan base revision does not match current project");
  }
}

export type RoughCutMedia = MediaContext;
