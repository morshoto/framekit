import { diffSnapshots } from "../diff/diff.js";
import type {
  AgentContext,
  AssetSearchQuery,
  ContextDiff,
  ContextRevision,
  EditorChange,
  EditorPort,
  EditorLiveState,
  MediaUnderstanding,
  ProjectSnapshot,
  RuntimeCapabilities,
  TimelineDiff,
} from "../domain/types.js";

export class ContextEngine {
  private readonly snapshots = new Map<string, ProjectSnapshot>();
  private readonly mediaUnderstanding = new Map<string, MediaUnderstanding>();

  public constructor(private readonly editor: EditorPort) {}

  public async inspectProject(): Promise<ProjectSnapshot> {
    const snapshot = await this.editor.readProject();
    const enriched = this.withAttachedUnderstanding(snapshot);
    this.snapshots.set(enriched.revision.id, structuredClone(enriched));
    return enriched;
  }

  public async changesSince(revision: ContextRevision): Promise<TimelineDiff> {
    const incremental = await this.editor.readChanges?.(revision);
    if (incremental?.timeline) return incremental.timeline;

    const before = this.snapshots.get(revision.id);
    const capabilities = await this.editor.getCapabilities();
    if (!capabilities.editor.timelineSnapshotRead) {
      throw new Error("CAPABILITY_UNAVAILABLE: canonical timeline changes");
    }
    if (!before) throw new Error(`REVISION_NOT_FOUND: ${revision.id}`);
    return diffSnapshots(before, await this.inspectProject());
  }

  public async contextChangesSince(revision: ContextRevision, waitMs = 0): Promise<ContextDiff> {
    const incremental = await this.editor.readChanges?.(revision);
    const timeline = incremental?.timeline ?? await this.optionalTimelineChanges(revision);
    const stateChanges = [
      ...(incremental?.stateChanges ?? []),
      ...(await this.liveChangesSince(revision, waitMs)),
    ];
    const assetChanges = incremental?.assetChanges ?? [];
    const to = latestRevision(revision, timeline?.to, ...stateChanges.map((change) => change.revision), incremental?.to);
    return {
      from: revision,
      to,
      timeline,
      stateChanges: dedupeStateChanges(stateChanges),
      assetChanges,
    };
  }

  public async inspectContext(capabilities: RuntimeCapabilities): Promise<AgentContext> {
    const project = await this.inspectProject();
    const editorState = await this.optionalLiveState();
    const revision = project.revision;
    return {
      revision,
      project,
      ...(editorState ? { editorState } : {}),
      media: project.media,
      recentChanges: {
        from: revision,
        to: revision,
        stateChanges: [],
        assetChanges: [],
      },
      capabilities,
    };
  }

  public attachMediaUnderstanding(understanding: MediaUnderstanding): void {
    this.mediaUnderstanding.set(understanding.mediaId, structuredClone(understanding));
  }

  public async listAssets(query?: AssetSearchQuery) {
    if (!this.editor.listAssets) throw new Error("CAPABILITY_UNAVAILABLE: editor assets");
    return this.editor.listAssets(query);
  }

  private async optionalTimelineChanges(revision: ContextRevision): Promise<TimelineDiff | undefined> {
    const capabilities = await this.editor.getCapabilities();
    if (!capabilities.editor.timelineSnapshotRead) return undefined;
    return this.changesSince(revision);
  }

  private async liveChangesSince(revision: ContextRevision, waitMs: number): Promise<EditorChange[]> {
    const candidate = this.editor as Partial<{
      liveChangesSince(revision: ContextRevision, waitMs?: number): Promise<EditorChange[]>;
    }>;
    if (typeof candidate.liveChangesSince !== "function") return [];
    return candidate.liveChangesSince(revision, waitMs);
  }

  private async optionalLiveState(): Promise<EditorLiveState | undefined> {
    const candidate = this.editor as Partial<{
      readLiveState(): Promise<EditorLiveState>;
    }>;
    if (typeof candidate.readLiveState !== "function") return undefined;
    return candidate.readLiveState();
  }

  private withAttachedUnderstanding(snapshot: ProjectSnapshot): ProjectSnapshot {
    const next = structuredClone(snapshot);
    next.media = next.media.map((media) => {
      const understanding = this.mediaUnderstanding.get(media.mediaId);
      if (!understanding || understanding.source !== media.source) return media;
      return {
        ...media,
        speech: understanding.speech,
        audio: understanding.audio,
        visual: understanding.visual,
        analysisRevision: understanding.analysisRevision.id,
      };
    });
    return next;
  }
}

function latestRevision(base: ContextRevision, ...candidates: Array<ContextRevision | undefined>): ContextRevision {
  return candidates.filter((candidate): candidate is ContextRevision => Boolean(candidate))
    .reduce((latest, candidate) => candidate.sequence > latest.sequence ? candidate : latest, base);
}

function dedupeStateChanges(changes: EditorChange[]): EditorChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.kind}:${change.revision.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
