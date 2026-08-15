import type {
  Clip,
  ContextRevision,
  EditOperation,
  EditorCapabilities,
  EditorIdentity,
  EditorPort,
  EditorAsset,
  MediaContext,
  Marker,
  ProjectSnapshot,
} from "../core/types.js";

export interface InMemoryFixture {
  projectId: string;
  projectName: string;
  timelineId: string;
  timelineName: string;
  clips: Clip[];
  media?: MediaContext[];
  markers?: Marker[];
  assets?: EditorAsset[];
}

export class InMemoryEditorAdapter implements EditorPort {
  private snapshot: ProjectSnapshot;
  private readonly assets: EditorAsset[];

  public constructor(fixture: InMemoryFixture) {
    this.assets = structuredClone(fixture.assets ?? []);
    this.snapshot = {
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      timeline: {
        id: fixture.timelineId,
        name: fixture.timelineName,
        duration: fixture.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
        clips: fixture.clips.map((clip) => ({ ...clip })),
        markers: structuredClone(fixture.markers ?? []),
        captions: [],
      },
      media: structuredClone(fixture.media ?? []),
      revision: {
        id: "rev-0",
        sequence: 0,
        timestamp: new Date(0).toISOString(),
      },
    };
  }

  public async read(): Promise<ProjectSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async readProject(): Promise<ProjectSnapshot> {
    return this.read();
  }

  public async getIdentity(): Promise<EditorIdentity> {
    return { name: "In-memory Editor", version: "phase-1-fixture", backend: "fixture" };
  }

  public async getCapabilities(): Promise<EditorCapabilities> {
    return {
      projectRead: true,
      timelineRead: true,
      timelineWrite: true,
      readAfterWrite: true,
      incrementalChanges: true,
      speechAnalysis: true,
      audioAnalysis: true,
      rollback: true,
      visualAnalysis: false,
      assetDiscovery: true,
    };
  }

  public async listAssets(): Promise<EditorAsset[]> {
    return structuredClone(this.assets ?? []);
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<void> {
    if (this.snapshot.revision.id !== expectedRevision.id) {
      throw new Error("STALE_CONTEXT: editor revision changed before write");
    }

    if (operation.type === "ripple-delete") {
      this.applyRippleDelete(operation.timelineId, operation.range.start, operation.range.end);
      return;
    }
    if (operation.type === "add-marker") {
      if (operation.timelineId !== this.snapshot.timeline.id) throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
      this.snapshot = this.nextSnapshot({
        ...this.snapshot,
        timeline: {
          ...this.snapshot.timeline,
          markers: [...this.snapshot.timeline.markers, { ...operation.marker }],
        },
      });
      return;
    }

    const clip = this.snapshot.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!clip) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
    let updatedClip: Clip;
    switch (operation.type) {
      case "rename-clip":
        if (operation.name.trim().length === 0) {
          throw new Error("INVALID_OPERATION: clip name cannot be empty");
        }
        updatedClip = { ...clip, name: operation.name };
        break;
      case "trim-clip":
        if ((!Number.isFinite(operation.duration) || operation.duration <= 0) && !operation.durationTime) {
          throw new Error("INVALID_OPERATION: clip duration must be positive");
        }
        updatedClip = {
          ...clip,
          duration: operation.durationTime
            ? Number(operation.durationTime.value) / Number(operation.durationTime.timescale)
            : operation.duration,
          durationTime: operation.durationTime,
        };
        break;
      case "set-gain":
        if (!Number.isFinite(operation.gainDb)) {
          throw new Error("INVALID_OPERATION: gain must be finite");
        }
        updatedClip = { ...clip, gainDb: operation.gainDb };
        break;
      default:
        throw new Error(`UNSUPPORTED_OPERATION: ${(operation as { type: string }).type}`);
    }

    this.snapshot = this.nextSnapshot({
      ...this.snapshot,
      timeline: {
        ...this.snapshot.timeline,
        clips: this.snapshot.timeline.clips.map((candidate) =>
          candidate.id === operation.clipId ? updatedClip : candidate,
        ),
      },
    });
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    if (this.snapshot.revision.id !== expectedRevision.id) {
      throw new Error("STALE_CONTEXT: editor revision changed before rollback");
    }
    this.snapshot = {
      ...structuredClone(snapshot),
      revision: {
        id: `rev-${this.snapshot.revision.sequence + 1}`,
        sequence: this.snapshot.revision.sequence + 1,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private applyRippleDelete(timelineId: string, start: number, end: number): void {
    if (timelineId !== this.snapshot.timeline.id) throw new Error(`TIMELINE_NOT_FOUND: ${timelineId}`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error("INVALID_OPERATION: ripple delete range must be positive");
    }
    const removedDuration = end - start;
    const clips = this.snapshot.timeline.clips.flatMap((clip) => {
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= start) return [clip];
      if (clip.start >= end) return [{ ...clip, start: clip.start - removedDuration }];
      const overlap = Math.min(clipEnd, end) - Math.max(clip.start, start);
      const duration = clip.duration - overlap;
      if (duration <= 0) return [];
      return [{
        ...clip,
        start: clip.start < start ? clip.start : start,
        duration,
      }];
    });
    const markers = this.snapshot.timeline.markers.flatMap((marker) => {
      if (marker.start >= end) return [{ ...marker, start: marker.start - removedDuration }];
      if (marker.start + marker.duration <= start) return [marker];
      return [];
    });
    this.snapshot = this.nextSnapshot({
      ...this.snapshot,
      timeline: { ...this.snapshot.timeline, clips, markers },
    });
  }

  private nextSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
    return {
      ...snapshot,
      timeline: {
        ...snapshot.timeline,
        duration: snapshot.timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
      },
      revision: {
        id: `rev-${snapshot.revision.sequence + 1}`,
        sequence: snapshot.revision.sequence + 1,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
