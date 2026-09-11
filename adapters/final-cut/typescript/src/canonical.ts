import {
  canonicalSnapshotDigest,
  withCapabilityFamilies,
  type ContextRevision,
  type EditorChange,
  type EditorIdentity,
  type EditorLiveState,
  type EditOperation,
  type EditorPort,
  type LiveEditorStatePort,
  type ProjectCatalog,
  type ProjectSelection,
  type ProjectSnapshot,
  type RuntimeCapabilities,
} from "@framekit/runtime";

export interface CanonicalNativeMutationPort {
  renameSelectedClip(name: string): Promise<{ operationId: string; undoAvailable: boolean }>;
  undo(operationId: string): Promise<{ undone: boolean; verification?: { verified: boolean } }>;
}

export type CanonicalNativeTargetResolver = (
  clip: ProjectSnapshot["timeline"]["clips"][number],
  snapshot: ProjectSnapshot,
) => Promise<void>;

export interface FinalCutCanonicalNativeProviderOptions {
  live: LiveEditorStatePort & { getIdentity(): Promise<EditorIdentity> };
  native: CanonicalNativeMutationPort;
  readSnapshot: () => Promise<ProjectSnapshot>;
  resolveTarget: CanonicalNativeTargetResolver;
}

interface PendingNativeOperation {
  operationId: string;
  beforeDigest: string;
  beforeRevision: ContextRevision;
  afterRevision: ContextRevision;
}

/**
 * Canonical provider for the headed Final Cut UI path.
 *
 * `readSnapshot` must export the currently active Final Cut project through
 * Final Cut itself. It is deliberately injected so the provider cannot fall
 * back to an arbitrary FCPXML artifact. Native mutation is separately bound
 * to one exported occurrence before Accessibility is allowed to edit it.
 */
export class FinalCutCanonicalNativeProvider implements EditorPort, LiveEditorStatePort {
  private readonly live: FinalCutCanonicalNativeProviderOptions["live"];
  private readonly native: CanonicalNativeMutationPort;
  private readonly readSnapshotSource: () => Promise<ProjectSnapshot>;
  private readonly resolveTarget: CanonicalNativeTargetResolver;
  private lastDigest?: string;
  private lastSnapshot?: ProjectSnapshot;
  private revisionSequence = 0;
  private revision?: ContextRevision;
  private pending?: PendingNativeOperation;

  public constructor(options: FinalCutCanonicalNativeProviderOptions) {
    this.live = options.live;
    this.native = options.native;
    this.readSnapshotSource = options.readSnapshot;
    this.resolveTarget = options.resolveTarget;
  }

  public async getIdentity(): Promise<EditorIdentity> {
    const identity = await this.live.getIdentity();
    return { ...identity, backend: "final-cut-native-canonical" };
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    return withCapabilityFamilies({
      editor: {
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: true,
        timelineArtifactWrite: false,
        readAfterWrite: true,
        incrementalChanges: true,
        rollback: true,
        assetDiscovery: false,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        playbackControl: false,
        projectCatalogRead: true,
        projectSelection: true,
      },
      analyzers: {
        speechTranscribe: false,
        speechVad: false,
        audioLoudness: false,
        visualTrack: false,
      },
    }, {
      backend: "final-cut-native-canonical",
      connectionBackend: "workflow-extension-ipc",
      canonicalDocument: { read: true, write: true, artifactWrite: false },
    });
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    const snapshot = await this.readSnapshotSource();
    await this.assertActiveTarget(snapshot);
    const digest = canonicalSnapshotDigest(snapshot);
    if (digest !== this.lastDigest || !this.revision) {
      this.revisionSequence = Math.max(this.revisionSequence + 1, snapshot.revision.sequence + 1);
      this.lastDigest = digest;
      this.revision = {
        id: `canonical:${digest}`,
        sequence: this.revisionSequence,
        timestamp: new Date().toISOString(),
      };
    }
    this.lastSnapshot = { ...snapshot, revision: this.revision };
    return structuredClone(this.lastSnapshot);
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    const before = await this.readProject();
    assertSameRevision(expectedRevision, before.revision);
    if (operation.type !== "rename-clip") {
      throw new Error(`CAPABILITY_UNAVAILABLE: final-cut native canonical provider does not support ${operation.type}`);
    }
    const clip = before.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!clip) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);

    await this.resolveTarget(clip, before);
    const nativeResult = await this.native.renameSelectedClip(operation.name);
    if (!nativeResult.operationId || !nativeResult.undoAvailable) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_UNAVAILABLE: native rename did not expose Undo");
    }
    this.pending = {
      operationId: nativeResult.operationId,
      beforeDigest: canonicalSnapshotDigest(before),
      beforeRevision: before.revision,
      afterRevision: before.revision,
    };

    const after = await this.readProject();
    const afterClip = after.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!afterClip || afterClip.name !== operation.name) {
      throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: renamed occurrence was not read back from Final Cut");
    }
    if (canonicalSnapshotDigest(after) === this.pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: native edit did not change the canonical digest");
    }
    this.pending.afterRevision = after.revision;
    return after.revision;
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    const current = await this.readProject();
    assertSameRevision(expectedRevision, current.revision);
    const pending = this.pending;
    if (!pending || !sameRevision(pending.afterRevision, expectedRevision)) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_STALE: native operation is not the current canonical edit");
    }
    if (canonicalSnapshotDigest(snapshot) !== pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_TARGET_MISMATCH: rollback target differs from the applied edit");
    }
    const undone = await this.native.undo(pending.operationId);
    if (!undone.undone || undone.verification?.verified !== true) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_FAILED: Final Cut did not verify native Undo");
    }
    const restored = await this.readProject();
    if (canonicalSnapshotDigest(restored) !== pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_FAILED: restored canonical digest does not match the pre-edit state");
    }
    this.pending = undefined;
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const snapshot = await this.readProject();
    return {
      projects: [{
        id: snapshot.projectId,
        name: snapshot.projectName,
        sequences: [{ id: snapshot.timeline.id, name: snapshot.timeline.name }],
      }],
      activeProjectId: snapshot.projectId,
      activeSequenceId: snapshot.timeline.id,
    };
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const catalog = await this.listProjects();
    const project = catalog.projects.find(({ id }) => id === selection.projectId);
    if (!project) throw new Error(`TARGET_MISMATCH: active project is not ${selection.projectId}`);
    const sequenceId = selection.sequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
    if (!sequenceId) throw new Error(`AMBIGUOUS_PROJECT_TARGET: sequenceId is required for ${selection.projectId}`);
    if (sequenceId !== catalog.activeSequenceId) throw new Error(`TARGET_MISMATCH: active sequence is not ${sequenceId}`);
    return catalog;
  }

  public async readLiveState(): Promise<EditorLiveState> {
    return this.live.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    return this.live.liveChangesSince(revision, waitMs);
  }

  private async assertActiveTarget(snapshot: ProjectSnapshot): Promise<void> {
    const live = await this.live.readLiveState();
    if (live.project && live.project.name !== snapshot.projectName) {
      throw new Error(`TARGET_MISMATCH: exported project ${snapshot.projectName} is not active Final Cut project ${live.project.name}`);
    }
    if (live.sequence && live.sequence.name !== snapshot.timeline.name) {
      throw new Error(`TARGET_MISMATCH: exported sequence ${snapshot.timeline.name} is not active Final Cut sequence ${live.sequence.name}`);
    }
  }
}

function assertSameRevision(expected: ContextRevision, actual: ContextRevision): void {
  if (!sameRevision(expected, actual)) throw new Error("STALE_CONTEXT: canonical Final Cut revision changed before mutation");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
