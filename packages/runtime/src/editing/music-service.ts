import type { CompositeEditPreview, MusicAddRequest, WorkflowOperation } from "../domain/editing.js";
import { EditService } from "./edit-service.js";
import { ProjectService } from "../application/project-service.js";

export class MusicService {
  public constructor(
    private readonly project: ProjectService,
    private readonly edits: EditService,
  ) {}

  public async previewMusic(request: MusicAddRequest): Promise<CompositeEditPreview> {
    if (request.ducking?.enabled) {
      throw new Error("CAPABILITY_UNAVAILABLE: dialogue ducking");
    }
    const before = await this.project.inspectProject();
    const operations: WorkflowOperation[] = [];
    const hasMediaId = request.mediaId !== undefined;
    const hasImport = request.import !== undefined;
    if (hasMediaId === hasImport) {
      throw new Error("INVALID_OPERATION: music requires exactly one mediaId or import source");
    }
    if (!Number.isInteger(request.targetLane) || request.targetLane === 0) {
      throw new Error("INVALID_OPERATION: music requires a non-primary target lane");
    }
    if (request.placement === "append" && request.start !== undefined) {
      throw new Error("INVALID_OPERATION: appended music cannot specify a start position");
    }
    const mediaId = request.import?.mediaId ?? request.mediaId!;
    if (request.import) {
      operations.push({
        type: "media.import",
        mediaId: request.import.mediaId,
        source: request.import.source,
        mediaKind: "audio",
        duration: request.import.duration,
        sourceDigest: request.import.sourceDigest,
      });
    }
    const media = before.media.find((candidate) => candidate.mediaId === mediaId);
    const duration = request.duration ?? request.import?.duration ?? media?.duration;
    const sourceDuration = request.import?.duration ?? media?.duration;
    if (duration === undefined) {
      throw new Error("INVALID_OPERATION: music duration is required when media duration is unavailable");
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("INVALID_OPERATION: music duration must be positive");
    }
    if (sourceDuration !== undefined && duration > sourceDuration) {
      throw new Error("INVALID_OPERATION: music duration exceeds the source duration");
    }
    const start = request.placement === "append" ? before.timeline.duration : request.start;
    if (start === undefined || !Number.isFinite(start) || start < 0) {
      throw new Error("INVALID_OPERATION: inserted music requires a non-negative start position");
    }
    operations.push({
      type: "timeline.media.add",
      occurrenceId: request.occurrenceId,
      mediaId,
      role: "music",
      start,
      duration,
      targetLane: request.targetLane,
    });
    if (request.gainDb !== undefined) {
      if (!Number.isFinite(request.gainDb)) throw new Error("INVALID_OPERATION: music gain must be finite");
      operations.push({ type: "set-gain", clipId: request.occurrenceId, gainDb: request.gainDb });
    }
    if (request.fadeIn !== undefined || request.fadeOut !== undefined) {
      const fadeIn = request.fadeIn ?? 0;
      const fadeOut = request.fadeOut ?? 0;
      if (!Number.isFinite(fadeIn) || !Number.isFinite(fadeOut) || fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > duration) {
        throw new Error("INVALID_OPERATION: music fades must be non-negative and fit within the music duration");
      }
      operations.push({
        type: "timeline.audio.fades",
        clipId: request.occurrenceId,
        fadeIn,
        fadeOut,
      });
    }
    return this.edits.previewEdit({
      baseRevision: request.baseRevision,
      operations,
      verification: request.verification,
    });
  }
}
