import { withCanonicalTimelineMode, withCapabilityFamilies } from "@framekit/runtime";
import type {
  ContextRevision,
  EditOperation,
  EditorAsset,
  EditorIdentity,
  EditorPort,
  EditorLiveState,
  EditorChange,
  AssetSearchQuery,
  LiveEditorStatePort,
  ProjectSnapshot,
  ProjectCatalog,
  ProjectSelection,
  RuntimeCapabilities,
  ManagedArtifact,
} from "@framekit/runtime";

interface FinalCutSessionOptions {
  snapshot?: EditorPort;
  mutation?: EditorPort;
  live?: LiveEditorStatePort & Partial<Pick<EditorPort, "readProject" | "apply" | "restore">> & {
    getIdentity(): Promise<EditorIdentity>;
    getCapabilities(): Promise<RuntimeCapabilities>;
    listProjects?(): Promise<ProjectCatalog>;
    selectProject?(selection: ProjectSelection): Promise<ProjectCatalog>;
  };
  assets?: Pick<EditorPort, "listAssets">;
}

/** Composes the independent Final Cut live, snapshot, and mutation surfaces. */
export class FinalCutSessionAdapter implements EditorPort, LiveEditorStatePort {
  public constructor(private readonly options: FinalCutSessionOptions) {}

  public async getIdentity(): Promise<EditorIdentity> {
    if (this.options.snapshot && this.options.live) {
      try {
        const live = await this.options.live.getIdentity();
        return { name: "Final Cut Pro", version: live.version, backend: "final-cut-session" };
      } catch {
        return { name: "Final Cut Pro", version: "FCPXML + live", backend: "final-cut-session" };
      }
    }
    if (this.options.snapshot) return this.options.snapshot.getIdentity();
    if (this.options.live) return this.options.live.getIdentity();
    return { name: "Final Cut Pro", version: "unknown", backend: "final-cut-session" };
  }

  public async getManagedArtifact(): Promise<ManagedArtifact> {
    if (this.options.snapshot?.getManagedArtifact) return this.options.snapshot.getManagedArtifact();
    throw new Error("CAPABILITY_UNAVAILABLE: managed FCPXML artifact");
  }

  public async getManagedArtifactDigest(): Promise<string | undefined> {
    return this.options.snapshot?.getManagedArtifactDigest?.();
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    const snapshot = await this.options.snapshot?.getCapabilities();
    const mutation = await this.options.mutation?.getCapabilities();
    const live = await optionalCapabilities(this.options.live);
    const hasExplicitDocumentPair = Boolean(this.options.snapshot && this.options.mutation);
    const useLiveCanonical = !this.options.snapshot && !this.options.mutation;
    const liveSnapshot = Boolean(
      useLiveCanonical
      && live?.editor.timelineSnapshotRead
      && live.editor.canonicalTimelineMode !== "metadata-only"
      && this.options.live?.readProject
    );
    const liveMutation = Boolean(
      liveSnapshot
      && live?.editor.canonicalTimelineMode === "canonical-write"
      && this.options.live?.apply
      && this.options.live.restore
    );
    const applyProviderCapabilities = hasExplicitDocumentPair
      ? mutation
      : liveMutation
        ? live
        : snapshot;
    return withCapabilityFamilies({
      editor: {
        projectRead: Boolean(snapshot?.editor.projectRead || (liveSnapshot && live?.editor.projectRead)),
        timelineSnapshotRead: Boolean(snapshot?.editor.timelineSnapshotRead || liveSnapshot),
        timelineWrite: Boolean((hasExplicitDocumentPair && mutation?.editor.timelineWrite) || liveMutation),
        timelineArtifactWrite: Boolean(applyProviderCapabilities?.editor.timelineArtifactWrite),
        readAfterWrite: Boolean(
          (hasExplicitDocumentPair && snapshot?.editor.readAfterWrite && mutation?.editor.readAfterWrite)
          || (liveMutation && live?.editor.readAfterWrite)
        ),
        incrementalChanges: Boolean(live?.editor.incrementalChanges),
        rollback: Boolean((hasExplicitDocumentPair && mutation?.editor.rollback) || liveMutation),
        assetDiscovery: Boolean(snapshot?.editor.assetDiscovery || this.options.assets?.listAssets),
        liveStateRead: Boolean(live?.editor.liveStateRead),
        playheadWrite: Boolean(live?.editor.playheadWrite),
        frameCapture: false,
        playbackControl: Boolean(live?.editor.playbackControl),
        projectCatalogRead: Boolean(snapshot?.editor.projectCatalogRead || (!this.options.snapshot && live?.editor.projectCatalogRead)),
        projectSelection: Boolean(snapshot?.editor.projectSelection || (!this.options.snapshot && live?.editor.projectSelection)),
      },
      analyzers: {
        speechTranscribe: Boolean(snapshot?.analyzers.speechTranscribe || mutation?.analyzers.speechTranscribe || live?.analyzers.speechTranscribe),
        speechVad: Boolean(snapshot?.analyzers.speechVad || mutation?.analyzers.speechVad || live?.analyzers.speechVad),
        audioLoudness: Boolean(snapshot?.analyzers.audioLoudness || mutation?.analyzers.audioLoudness || live?.analyzers.audioLoudness),
        visualTrack: Boolean(snapshot?.analyzers.visualTrack || mutation?.analyzers.visualTrack || live?.analyzers.visualTrack),
      },
    }, { backend: "final-cut-session" });
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    if (this.options.snapshot) return this.options.snapshot.readProject();
    const liveCapabilities = await optionalCapabilities(this.options.live);
    if (
      liveCapabilities?.editor.canonicalTimelineMode !== "metadata-only"
      && !this.options.mutation
      && liveCapabilities?.editor.timelineSnapshotRead
      && this.options.live?.readProject
    ) {
      return this.options.live.readProject();
    }
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no snapshot provider");
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    if (this.options.snapshot && this.options.mutation) {
      return this.options.mutation.apply(operation, expectedRevision);
    }
    const liveCapabilities = await optionalCapabilities(this.options.live);
    if (
      !this.options.snapshot
      && !this.options.mutation
      && liveCapabilities?.editor.canonicalTimelineMode === "canonical-write"
      && this.options.live?.apply
      && this.options.live.restore
    ) {
      return this.options.live.apply(operation, expectedRevision);
    }
    if (this.options.snapshot) {
      return this.options.snapshot.apply(operation, expectedRevision);
    }
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no mutation provider");
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    if (this.options.snapshot && this.options.mutation) {
      await this.options.mutation.restore(snapshot, expectedRevision);
      return;
    }
    const liveCapabilities = await optionalCapabilities(this.options.live);
    if (
      !this.options.snapshot
      && !this.options.mutation
      && liveCapabilities?.editor.canonicalTimelineMode === "canonical-write"
      && this.options.live?.apply
      && this.options.live.restore
    ) {
      await this.options.live.restore(snapshot, expectedRevision);
      return;
    }
    if (this.options.snapshot) {
      await this.options.snapshot.restore(snapshot, expectedRevision);
      return;
    }
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no mutation provider");
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    const provider = this.options.assets ?? this.options.snapshot;
    if (!provider?.listAssets) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut assets");
    return provider.listAssets(query);
  }

  public async listProjects(): Promise<ProjectCatalog> {
    if (this.options.snapshot?.listProjects) return this.options.snapshot.listProjects();
    if (!this.options.snapshot && this.options.live?.listProjects && (await optionalProjectCatalogCapability(this.options.live))) {
      return this.options.live.listProjects();
    }
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project catalog");
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    if (this.options.snapshot?.selectProject) return this.options.snapshot.selectProject(selection);
    if (!this.options.snapshot && this.options.live?.selectProject && (await optionalProjectSelectionCapability(this.options.live))) {
      return this.options.live.selectProject(selection);
    }
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project selection");
  }

  public async readLiveState(): Promise<EditorLiveState> {
    if (!this.options.live) throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
    return this.options.live.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    if (!this.options.live) throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
    return this.options.live.liveChangesSince(revision, waitMs);
  }
}

async function optionalCapabilities(
  live: FinalCutSessionOptions["live"],
): Promise<RuntimeCapabilities | undefined> {
  if (!live) return undefined;
  try {
    return withCanonicalTimelineMode(await live.getCapabilities());
  } catch {
    return undefined;
  }
}

async function optionalProjectCatalogCapability(
  live: FinalCutSessionOptions["live"],
): Promise<boolean> {
  try {
    return Boolean((await live?.getCapabilities())?.editor.projectCatalogRead);
  } catch {
    return false;
  }
}

async function optionalProjectSelectionCapability(
  live: FinalCutSessionOptions["live"],
): Promise<boolean> {
  try {
    return Boolean((await live?.getCapabilities())?.editor.projectSelection);
  } catch {
    return false;
  }
}
