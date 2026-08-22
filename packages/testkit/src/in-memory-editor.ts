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
  WorkflowOperation,
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
        compositeTransactions: true,
        mediaImport: true,
        mediaPlacement: true,
        titlePlacement: true,
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
    this.snapshot = this.nextSnapshot(this.applyOperation(this.snapshot, operation));
  }

  public async previewTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<ProjectSnapshot> {
    this.assertRevision(expectedRevision);
    const preview = operations.reduce(
      (snapshot, operation) => this.applyOperation(snapshot, operation),
      structuredClone(this.snapshot),
    );
    return structuredClone(withRevision(withTimelineDuration(preview), nextRevision(this.snapshot.revision)));
  }

  public async applyTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<void> {
    this.assertRevision(expectedRevision);
    const next = operations.reduce(
      (snapshot, operation) => this.applyOperation(snapshot, operation),
      structuredClone(this.snapshot),
    );
    this.snapshot = this.nextSnapshot(next);
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    if (this.snapshot.revision.id !== expectedRevision.id) {
      throw new Error("STALE_CONTEXT: editor revision changed before rollback");
    }
    if (snapshot.projectId !== this.activeProjectId || snapshot.timeline.id !== this.activeSequenceId) {
      throw new Error(
        `TARGET_MISMATCH: cannot restore ${snapshot.projectId}/${snapshot.timeline.id} while ${this.activeProjectId}/${this.activeSequenceId} is active`,
      );
    }
    this.snapshot = withRevision(structuredClone(snapshot), nextRevision(this.snapshot.revision));
    this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
  }

  private applyOperation(snapshot: ProjectSnapshot, operation: WorkflowOperation): ProjectSnapshot {
    if (operation.type === "media.import") {
      if (snapshot.media.some((media) => media.mediaId === operation.mediaId)) {
        throw new Error(`MEDIA_ALREADY_EXISTS: ${operation.mediaId}`);
      }
      if (!operation.source.trim() || !Number.isFinite(operation.duration) || operation.duration <= 0
        || !operation.sourceDigest.trim()) {
        throw new Error("INVALID_OPERATION: imported media requires source, duration, and digest");
      }
      return {
        ...snapshot,
        media: [...snapshot.media, {
          mediaId: operation.mediaId,
          source: operation.source,
          mediaKind: operation.mediaKind,
          duration: operation.duration,
          sourceDigest: operation.sourceDigest,
        }],
      };
    }
    if (operation.type === "timeline.media.add") {
      const media = snapshot.media.find((candidate) => candidate.mediaId === operation.mediaId);
      if (!media) throw new Error(`MEDIA_NOT_FOUND: ${operation.mediaId}`);
      if (snapshot.timeline.clips.some((clip) => clip.id === operation.occurrenceId)) {
        throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${operation.occurrenceId}`);
      }
      if (!Number.isFinite(operation.start) || !Number.isFinite(operation.duration)
        || operation.start < 0 || operation.duration <= 0) {
        throw new Error("INVALID_OPERATION: media placement timing");
      }
      const lane = operation.targetLane ?? (operation.role === "video" ? "primary" : undefined);
      if (operation.role === "video" && lane !== "primary") {
        throw new Error("INVALID_OPERATION: video must target the primary storyline");
      }
      if (operation.role === "music" && (typeof lane !== "number" || lane === 0)) {
        throw new Error("INVALID_OPERATION: music requires an explicit non-primary lane");
      }
      const clip = withClipTime({
        id: operation.occurrenceId,
        mediaId: operation.mediaId,
        name: media.source.split("/").pop() || media.mediaId,
        start: operation.start,
        duration: operation.duration,
        track: typeof lane === "number" ? lane : 0,
      });
      return {
        ...snapshot,
        timeline: {
          ...snapshot.timeline,
          clips: [...snapshot.timeline.clips, clip],
          storyElements: [...snapshot.timeline.storyElements, {
            id: clip.id,
            kind: "asset-clip",
            start: clip.start,
            duration: clip.duration,
            startTime: clip.startTime,
            durationTime: clip.durationTime,
            lane: clip.track,
            mediaId: clip.mediaId,
          }],
        },
      };
    }
    if (operation.type === "timeline.title.add") {
      const asset = this.assets.find((candidate) => candidate.id === operation.assetId && candidate.kind === "title");
      if (!asset) throw new Error(`TITLE_ASSET_NOT_FOUND: ${operation.assetId}`);
      if (snapshot.timeline.clips.some((clip) => clip.id === operation.occurrenceId)) {
        throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${operation.occurrenceId}`);
      }
      if (!operation.text.trim() || !Number.isFinite(operation.start) || !Number.isFinite(operation.duration)
        || operation.start < 0 || operation.duration <= 0 || operation.targetLane === 0) {
        throw new Error("INVALID_OPERATION: title text, timing, and non-primary lane are required");
      }
      const clip = withClipTime({
        id: operation.occurrenceId,
        name: operation.text,
        start: operation.start,
        duration: operation.duration,
        track: operation.targetLane,
      });
      return {
        ...snapshot,
        timeline: {
          ...snapshot.timeline,
          clips: [...snapshot.timeline.clips, clip],
          storyElements: [...snapshot.timeline.storyElements, {
            id: clip.id,
            kind: "title",
            start: clip.start,
            duration: clip.duration,
            startTime: clip.startTime,
            durationTime: clip.durationTime,
            lane: clip.track,
            assetId: operation.assetId,
            text: operation.text,
          }],
        },
      };
    }
    if (operation.type === "ripple-delete") {
      return this.applyRippleDelete(snapshot, operation.timelineId, operation.range.start, operation.range.end);
    }
    if (operation.type === "add-marker") {
      if (operation.timelineId !== snapshot.timeline.id) throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
      return {
        ...snapshot,
        timeline: {
          ...snapshot.timeline,
          markers: [...snapshot.timeline.markers, normalizeMarker(operation.marker)],
        },
      };
    }

    const clip = snapshot.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!clip) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
    let updatedClip: Clip;
    switch (operation.type) {
      case "rename-clip":
        if (!operation.name.trim()) throw new Error("INVALID_OPERATION: clip name cannot be empty");
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
        if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
        updatedClip = { ...clip, gainDb: operation.gainDb };
        break;
    }
    return {
      ...snapshot,
      timeline: {
        ...snapshot.timeline,
        clips: snapshot.timeline.clips.map((candidate) => candidate.id === operation.clipId ? updatedClip : candidate),
        storyElements: snapshot.timeline.storyElements.map((element) => element.id === operation.clipId
          ? { ...element, start: updatedClip.start, duration: updatedClip.duration, durationTime: updatedClip.durationTime }
          : element),
      },
    };
  }

  private applyRippleDelete(snapshot: ProjectSnapshot, timelineId: string, start: number, end: number): ProjectSnapshot {
    if (timelineId !== snapshot.timeline.id) throw new Error(`TIMELINE_NOT_FOUND: ${timelineId}`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error("INVALID_OPERATION: ripple delete range must be positive");
    }
    const removedDuration = end - start;
    const clips = snapshot.timeline.clips.flatMap((clip) => {
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
    const markers = snapshot.timeline.markers.flatMap((marker) => {
      if (marker.start >= end) return [normalizeMarker({ ...marker, start: marker.start - removedDuration })];
      if (marker.start + marker.duration <= start) return [marker];
      return [];
    });
    return {
      ...snapshot,
      timeline: {
        ...snapshot.timeline,
        clips,
        storyElements: snapshot.timeline.storyElements
          .filter((element) => clips.some((clip) => clip.id === element.id))
          .map((element) => {
            const clip = clips.find((candidate) => candidate.id === element.id);
            return clip ? { ...element, start: clip.start, duration: clip.duration, startTime: clip.startTime, durationTime: clip.durationTime } : element;
          }),
        markers,
      },
    };
  }

  private assertRevision(expectedRevision: ContextRevision): void {
    if (this.snapshot.revision.id !== expectedRevision.id) {
      throw new Error("STALE_CONTEXT: editor revision changed before write");
    }
  }

  private nextSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
    const next = withRevision(withTimelineDuration(snapshot), nextRevision(snapshot.revision));
    this.history.set(next.revision.id, structuredClone(next));
    return next;
  }
}

function nextRevision(revision: ContextRevision): ContextRevision {
  const sequence = revision.sequence + 1;
  return {
    id: `rev-${sequence}`,
    sequence,
    timestamp: new Date(sequence).toISOString(),
  };
}

function withTimelineDuration(snapshot: ProjectSnapshot): ProjectSnapshot {
  const duration = snapshot.timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  return {
    ...snapshot,
    timeline: {
      ...snapshot.timeline,
      duration,
      durationTime: decimalToRational(duration),
    },
  };
}

function withRevision(snapshot: ProjectSnapshot, revision: ContextRevision): ProjectSnapshot {
  return { ...snapshot, revision };
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
