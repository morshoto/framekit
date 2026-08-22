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
  RuntimeCapabilities,
} from "@framekit/runtime";

interface FinalCutSessionOptions {
  snapshot?: EditorPort;
  mutation?: EditorPort;
  live?: LiveEditorStatePort & {
    getIdentity(): Promise<EditorIdentity>;
    getCapabilities(): Promise<RuntimeCapabilities>;
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

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    const snapshot = await this.options.snapshot?.getCapabilities();
    const mutation = await this.options.mutation?.getCapabilities();
    const live = await optionalCapabilities(this.options.live);
    return {
      editor: {
        projectRead: Boolean(snapshot?.editor.projectRead),
        timelineSnapshotRead: Boolean(snapshot?.editor.timelineSnapshotRead),
        timelineWrite: Boolean(mutation?.editor.timelineWrite),
        timelineArtifactWrite: Boolean(mutation?.editor.timelineArtifactWrite),
        readAfterWrite: Boolean(snapshot?.editor.readAfterWrite && mutation?.editor.readAfterWrite),
        incrementalChanges: Boolean(live?.editor.incrementalChanges),
        rollback: Boolean(mutation?.editor.rollback),
        assetDiscovery: Boolean(snapshot?.editor.assetDiscovery || this.options.assets?.listAssets),
        liveStateRead: Boolean(live?.editor.liveStateRead),
        playheadWrite: Boolean(live?.editor.playheadWrite),
        playbackControl: Boolean(live?.editor.playbackControl),
      },
      analyzers: {
        speechTranscribe: Boolean(snapshot?.analyzers.speechTranscribe || mutation?.analyzers.speechTranscribe || live?.analyzers.speechTranscribe),
        speechVad: Boolean(snapshot?.analyzers.speechVad || mutation?.analyzers.speechVad || live?.analyzers.speechVad),
        audioLoudness: Boolean(snapshot?.analyzers.audioLoudness || mutation?.analyzers.audioLoudness || live?.analyzers.audioLoudness),
        visualTrack: Boolean(snapshot?.analyzers.visualTrack || mutation?.analyzers.visualTrack || live?.analyzers.visualTrack),
      },
    };
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    if (!this.options.snapshot) {
      throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no snapshot provider");
    }
    return this.options.snapshot.readProject();
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<void> {
    const provider = this.options.mutation ?? this.options.snapshot;
    if (!provider) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no mutation provider");
    await provider.apply(operation, expectedRevision);
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    const provider = this.options.mutation ?? this.options.snapshot;
    if (!provider) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut session has no mutation provider");
    await provider.restore(snapshot, expectedRevision);
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    const provider = this.options.assets ?? this.options.snapshot;
    if (!provider?.listAssets) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut assets");
    return provider.listAssets(query);
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
    return await live.getCapabilities();
  } catch {
    return undefined;
  }
}
