import { diffSnapshots } from "../timeline/snapshot-diff.js";
import type {
  AgentContext,
  ContextDiff,
  EditorChange,
  EditorLiveState,
  TimelineChangesRequest,
  TimelineChangesResult,
} from "../domain/context.js";
import type { AssetSearchQuery, EditorPort } from "../domain/ports.js";
import type { ContextRevision } from "../domain/primitives.js";
import { sameMediaSourceIdentity, type MediaUnderstanding } from "../domain/media.js";
import { sameRevision } from "./revision.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { RuntimeCapabilities } from "../domain/capabilities.js";
import type { TimelineDiff } from "../domain/diff.js";

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
    const capabilities = await this.editor.getCapabilities();
    if (capabilities.editor.incrementalChanges) {
      const incremental = await this.editor.readChanges?.(revision);
      if (incremental?.timeline) return incremental.timeline;
    }

    const before = this.snapshots.get(revision.id);
    if (!capabilities.editor.timelineSnapshotRead) {
      throw new Error("CAPABILITY_UNAVAILABLE: canonical timeline changes");
    }
    if (!before) throw new Error(`REVISION_NOT_FOUND: ${revision.id}`);
    return diffSnapshots(before, await this.inspectProject());
  }

  public async timelineChangesSince(request: TimelineChangesRequest): Promise<TimelineChangesResult> {
    const identity = await this.editor.getIdentity();
    const capabilities = await this.editor.getCapabilities();
    const canonical = capabilities.editor.canonicalTimelineMode !== "metadata-only"
      && (capabilities.editor.timelineSnapshotRead || capabilities.editor.incrementalChanges);
    const source = {
      source: identity.name,
      backend: identity.backend,
      guarantee: canonical ? "canonical-read" as const : "metadata-only" as const,
    };

    if (!canonical) {
      return {
        status: "unavailable",
        target: structuredClone(request.target),
        source,
        from: structuredClone(request.from),
        changes: [],
        reason: "canonical timeline changes are unavailable",
      };
    }

    const resolvedTarget = await this.resolveTimelineChangesTarget(request.target, source);
    if (resolvedTarget.status !== "ready") {
      return {
        ...resolvedTarget,
        from: structuredClone(request.from),
        changes: [],
      };
    }

    const before = this.snapshots.get(request.from.id);
    if (!before) {
      return {
        status: "stale",
        target: resolvedTarget.target,
        source,
        from: structuredClone(request.from),
        changes: [],
        reason: `revision ${request.from.id} was not observed in the canonical context`,
      };
    }
    if (before.projectId !== resolvedTarget.target.projectId || before.timeline.id !== resolvedTarget.target.sequenceId) {
      return {
        status: "stale",
        target: resolvedTarget.target,
        source,
        from: structuredClone(request.from),
        changes: [],
        reason: "requested target does not match the active target at the observed revision",
      };
    }

    try {
      const timeline = await this.changesSince(request.from);
      return {
        status: "ready",
        target: resolvedTarget.target,
        source,
        from: structuredClone(request.from),
        to: structuredClone(timeline.to),
        changes: structuredClone(timeline.changes),
        timeline,
      };
    } catch (error) {
      const reason = String(error);
      if (reason.includes("REVISION_NOT_FOUND") || reason.includes("STALE_CONTEXT")) {
        return {
          status: "stale",
          target: resolvedTarget.target,
          source,
          from: structuredClone(request.from),
          changes: [],
          reason,
        };
      }
      if (reason.includes("CAPABILITY_UNAVAILABLE")) {
        return {
          status: "unavailable",
          target: resolvedTarget.target,
          source,
          from: structuredClone(request.from),
          changes: [],
          reason,
        };
      }
      throw error;
    }
  }

  public async contextChangesSince(revision: ContextRevision, waitMs = 0): Promise<ContextDiff> {
    const capabilities = await this.editor.getCapabilities();
    const incremental = capabilities.editor.incrementalChanges
      ? await this.editor.readChanges?.(revision)
      : undefined;
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

  private async resolveTimelineChangesTarget(
    requested: TimelineChangesRequest["target"],
    source: TimelineChangesResult["source"],
  ): Promise<Pick<TimelineChangesResult, "status" | "target" | "source" | "reason">> {
    if (requested.sequenceId) {
      return {
        status: "ready",
        target: structuredClone({ projectId: requested.projectId, sequenceId: requested.sequenceId }),
        source,
      };
    }

    if (!this.editor.listProjects) {
      return {
        status: "unavailable",
        target: structuredClone(requested),
        source: { ...source, guarantee: "metadata-only" },
        reason: "project sequence catalog is unavailable",
      };
    }
    const catalog = await this.editor.listProjects();
    const project = catalog.projects.find((candidate) => candidate.id === requested.projectId);
    if (!project) {
      return {
        status: "stale",
        target: structuredClone(requested),
        source,
        reason: `project ${requested.projectId} is not present in the canonical catalog`,
      };
    }
    if (project.sequences.length !== 1 || !project.sequences[0]) {
      return {
        status: "ambiguous",
        target: structuredClone(requested),
        source,
        reason: `project ${requested.projectId} has multiple sequences; sequenceId is required`,
      };
    }
    return {
      status: "ready",
      target: { projectId: requested.projectId, sequenceId: project.sequences[0].id },
      source,
    };
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
    try {
      return await candidate.liveChangesSince(revision, waitMs);
    } catch (error) {
      if (isOptionalLiveUnavailable(error)) return [];
      throw error;
    }
  }

  private async optionalLiveState(): Promise<EditorLiveState | undefined> {
    const candidate = this.editor as Partial<{
      readLiveState(): Promise<EditorLiveState>;
    }>;
    if (typeof candidate.readLiveState !== "function") return undefined;
    try {
      return await candidate.readLiveState();
    } catch (error) {
      if (isOptionalLiveUnavailable(error)) return undefined;
      throw error;
    }
  }

  private withAttachedUnderstanding(snapshot: ProjectSnapshot): ProjectSnapshot {
    const next = structuredClone(snapshot);
    next.media = next.media.map((media) => {
      const understanding = this.mediaUnderstanding.get(media.mediaId);
      if (!understanding) return media;
      if (!isCurrentUnderstanding(understanding, media, snapshot.revision)) {
        this.mediaUnderstanding.delete(media.mediaId);
        return media;
      }
      const attached = structuredClone(understanding);
      return {
        ...media,
        metadata: attached.metadata,
        speech: attached.speech,
        audio: attached.audio,
        visual: attached.visual,
        semantic: attached.semantic,
        analysis: attached.analysis,
        analysisRevision: attached.analysisRevision.id,
      };
    });
    return next;
  }
}

function isCurrentUnderstanding(
  understanding: MediaUnderstanding,
  media: ProjectSnapshot["media"][number],
  revision: ContextRevision,
): boolean {
  return sameMediaSourceIdentity(understanding.sourceIdentity, media)
    && sameRevision(understanding.analysisRevision, revision);
}

function isOptionalLiveUnavailable(error: unknown): boolean {
  const message = String(error);
  return message.includes("FINAL_CUT_LIVE_UNAVAILABLE") || message.includes("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
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
