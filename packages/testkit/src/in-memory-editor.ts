import type {
  Clip,
  ContextChangeSet,
  ContextRevision,
  EditOperation,
  EditorCapabilities,
  EditorIdentity,
  EditorPort,
  EditorAsset,
  AssetSearchQuery,
  MediaContext,
  Marker,
  ProjectSnapshot,
  ProjectCatalog,
  ProjectSelection,
  RationalTime,
  RuntimeCapabilities,
} from "@framekit/runtime";
import { diffSnapshots } from "@framekit/runtime";

export interface InMemoryProjectFixture {
  projectId: string;
  projectName: string;
  timelineId: string;
  timelineName: string;
  clips: Array<Omit<Clip, "startTime" | "durationTime"> & Partial<Pick<Clip, "startTime" | "durationTime">>>;
  media?: MediaContext[];
  markers?: Marker[];
  assets?: EditorAsset[];
}

export interface InMemoryFixture extends InMemoryProjectFixture {
  projects?: ProjectCatalog["projects"];
  /** Canonical snapshots available for explicit project selection. */
  projectSnapshots?: InMemoryProjectFixture[];
}

export class InMemoryEditorAdapter implements EditorPort {
  private snapshot: ProjectSnapshot;
  private readonly assets: EditorAsset[];
  private readonly history = new Map<string, ProjectSnapshot>();
  private readonly snapshotsByTarget: Map<string, ProjectSnapshot>;
  private readonly projects: ProjectCatalog["projects"];
  private activeProjectId: string;
  private activeSequenceId: string;
  private selectionRevision = 0;

  public constructor(fixture: InMemoryFixture) {
    this.assets = structuredClone(fixture.assets ?? []);
    this.projects = structuredClone(fixture.projects ?? [{
      id: fixture.projectId,
      name: fixture.projectName,
      sequences: [{ id: fixture.timelineId, name: fixture.timelineName }],
    }]);
    this.snapshotsByTarget = new Map((fixture.projectSnapshots ?? [fixture]).map((candidate) => [
      snapshotKey(candidate.projectId, candidate.timelineId),
      createSnapshot(candidate),
    ]));
    this.activeProjectId = fixture.projectId;
    this.activeSequenceId = fixture.timelineId;
    const initialSnapshot = this.snapshotsByTarget.get(snapshotKey(fixture.projectId, fixture.timelineId));
    if (!initialSnapshot) throw new Error(`PROJECT_NOT_FOUND: ${fixture.projectId}`);
    this.snapshot = structuredClone(initialSnapshot);
    this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
  }

  public async read(): Promise<ProjectSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async readProject(): Promise<ProjectSnapshot> {
    return this.read();
  }

  public async getIdentity(): Promise<EditorIdentity> {
    return { name: "In-memory Editor", version: "phase-2-fixture", backend: "fixture" };
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      editor: {
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: true,
        timelineArtifactWrite: false,
        readAfterWrite: true,
        incrementalChanges: true,
        rollback: true,
        assetDiscovery: true,
        liveStateRead: false,
        playheadWrite: false,
        projectCatalogRead: true,
        projectSelection: true,
      },
      analyzers: {
        speechTranscribe: false,
        speechVad: false,
        audioLoudness: false,
        visualTrack: false,
      },
    };
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    const normalized = query?.query?.trim().toLowerCase();
    return structuredClone(this.assets.filter((asset) => {
      if (normalized && ![asset.id, asset.name, asset.vendor].some((value) => value.toLowerCase().includes(normalized))) return false;
      if (query?.kind && asset.kind !== query.kind) return false;
      if (query?.vendor && asset.vendor.toLowerCase() !== query.vendor.trim().toLowerCase()) return false;
      return true;
    }));
  }

  public async listProjects(): Promise<ProjectCatalog> {
    return {
      projects: structuredClone(this.projects),
      activeProjectId: this.activeProjectId,
      activeSequenceId: this.activeSequenceId,
    };
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const project = this.projects.find((candidate) => candidate.id === selection.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND: ${selection.projectId}`);
    const sequenceId = selection.sequenceId
      ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
    if (!sequenceId) throw new Error(`AMBIGUOUS_PROJECT_TARGET: ${selection.projectId} has multiple sequences`);
    if (!project.sequences.some((sequence) => sequence.id === sequenceId)) {
      throw new Error(`SEQUENCE_NOT_FOUND: ${sequenceId}`);
    }
    const target = this.snapshotsByTarget.get(snapshotKey(project.id, sequenceId));
    if (!target) {
      throw new Error(`UNSUPPORTED_PROJECT_SELECTION: no canonical snapshot for ${project.id}`);
    }
    if (target.timeline.id !== sequenceId) {
      throw new Error(`UNSUPPORTED_PROJECT_SELECTION: no canonical snapshot for sequence ${sequenceId}`);
    }
    if (this.activeProjectId === project.id && this.activeSequenceId === sequenceId) return this.listProjects();
    this.selectionRevision += 1;
    this.snapshot = {
      ...structuredClone(target),
      revision: {
        id: `rev-select-${this.selectionRevision}`,
        sequence: this.selectionRevision,
        timestamp: new Date(this.selectionRevision).toISOString(),
      },
    };
    this.history.clear();
    this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
    this.activeProjectId = project.id;
    this.activeSequenceId = sequenceId;
    return this.listProjects();
  }

  public async readChanges(since: ContextRevision): Promise<ContextChangeSet> {
    const before = this.history.get(since.id);
    if (!before) throw new Error(`REVISION_NOT_FOUND: ${since.id}`);
    return {
      from: before.revision,
      to: this.snapshot.revision,
      timeline: diffSnapshots(before, this.snapshot),
      stateChanges: [],
      assetChanges: [],
    };
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
          markers: [...this.snapshot.timeline.markers, normalizeMarker(operation.marker)],
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
          durationTime: operation.durationTime ?? decimalToRational(operation.duration),
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
        storyElements: this.snapshot.timeline.storyElements.map((element) =>
          element.id === operation.clipId
            ? { ...element, start: updatedClip.start, duration: updatedClip.duration, durationTime: updatedClip.durationTime }
            : element,
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
    this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
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
      if (clip.start >= end) return [withClipTime({ ...clip, start: clip.start - removedDuration })];
      const overlap = Math.min(clipEnd, end) - Math.max(clip.start, start);
      const duration = clip.duration - overlap;
      if (duration <= 0) return [];
      return [withClipTime({
        ...clip,
        start: clip.start < start ? clip.start : start,
        duration,
      })];
    });
    const markers = this.snapshot.timeline.markers.flatMap((marker) => {
      if (marker.start >= end) return [normalizeMarker({ ...marker, start: marker.start - removedDuration })];
      if (marker.start + marker.duration <= start) return [marker];
      return [];
    });
    this.snapshot = this.nextSnapshot({
      ...this.snapshot,
      timeline: {
        ...this.snapshot.timeline,
        clips,
        storyElements: this.snapshot.timeline.storyElements
          .filter((element) => clips.some((clip) => clip.id === element.id))
          .map((element) => {
            const clip = clips.find((candidate) => candidate.id === element.id);
            return clip ? { ...element, start: clip.start, duration: clip.duration, startTime: clip.startTime, durationTime: clip.durationTime } : element;
          }),
        markers,
        durationTime: decimalToRational(clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)),
      },
    });
  }

  private nextSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
    const next = {
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
    this.history.set(next.revision.id, structuredClone(next));
    return next;
  }
}

function createSnapshot(fixture: InMemoryProjectFixture): ProjectSnapshot {
  const clips = fixture.clips.map((clip) => normalizeClip(clip));
  return {
    projectId: fixture.projectId,
    projectName: fixture.projectName,
    timeline: {
      id: fixture.timelineId,
      name: fixture.timelineName,
      duration: clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
      durationTime: decimalToRational(clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)),
      clips,
      storyElements: clips.map((clip) => ({
        id: clip.id,
        kind: "asset-clip",
        start: clip.start,
        duration: clip.duration,
        startTime: clip.startTime,
        durationTime: clip.durationTime,
        lane: clip.track,
        mediaId: clip.mediaId,
      })),
      markers: (fixture.markers ?? []).map((marker) => normalizeMarker(marker)),
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

function snapshotKey(projectId: string, timelineId: string): string {
  return `${projectId}\u0000${timelineId}`;
}

function normalizeClip(clip: InMemoryProjectFixture["clips"][number]): Clip {
  return withClipTime({ ...clip, startTime: clip.startTime, durationTime: clip.durationTime });
}

function withClipTime(clip: Omit<Clip, "startTime" | "durationTime"> & Partial<Pick<Clip, "startTime" | "durationTime">>): Clip {
  return {
    ...clip,
    startTime: clip.startTime ?? decimalToRational(clip.start),
    durationTime: clip.durationTime ?? decimalToRational(clip.duration),
  };
}

function normalizeMarker(marker: Marker): Marker {
  return { ...marker, startTime: marker.startTime ?? decimalToRational(marker.start), durationTime: marker.durationTime ?? decimalToRational(marker.duration) };
}

function decimalToRational(value: number): RationalTime {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text, timescale: "1" };
  const decimals = text.split(".")[1].length;
  const scale = 10 ** decimals;
  return { value: String(Math.round(value * scale)), timescale: String(scale) };
}
