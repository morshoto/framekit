import { diffSnapshots } from "../timeline/snapshot-diff.js";
import type {
  AgentContext,
  ContextChangedScope,
  ContextCursor,
  ContextDiff,
  ContextProvenance,
  ContextTarget,
  EditorChange,
  EditorLiveState,
} from "../domain/context.js";
import type { AssetSearchQuery, EditorPort } from "../domain/ports.js";
import type { ContextRevision } from "../domain/primitives.js";
import { sameMediaSourceIdentity, type MediaUnderstanding } from "../domain/media.js";
import { sameRevision } from "./revision.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { RuntimeCapabilities } from "../domain/capabilities.js";
import type { TimelineDiff } from "../domain/diff.js";
import { withCanonicalTimelineMode, withCapabilityFamilies } from "../capabilities.js";

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

  public async contextChangesSince(
    cursorOrRevision: ContextCursor | ContextRevision,
    waitMs = 0,
  ): Promise<ContextDiff> {
    const cursor = isContextCursor(cursorOrRevision) ? cursorOrRevision : undefined;
    const revision = cursor?.revision ?? cursorOrRevision;
    if (cursor?.target) await this.validateCursorTarget(revision, cursor.target);
    const identity = await this.editor.getIdentity();
    const capabilities = withCanonicalTimelineMode(withCapabilityFamilies(await this.editor.getCapabilities(), {
      backend: identity.backend,
    }));
    const incremental = capabilities.editor.incrementalChanges
      ? await this.editor.readChanges?.(revision)
      : undefined;
    const timeline = canonicalTimelineAvailable(capabilities)
      ? incremental?.timeline ?? await this.optionalTimelineChanges(revision)
      : undefined;
    const stateChanges = [
      ...(incremental?.stateChanges ?? []),
      ...(await this.liveChangesSince(revision, waitMs)),
    ];
    const assetChanges = canonicalTimelineAvailable(capabilities)
      ? incremental?.assetChanges ?? []
      : [];
    const to = latestRevision(revision, timeline?.to, ...stateChanges.map((change) => change.revision), incremental?.to);
    let target = contextTarget(this.snapshots.get(revision.id), stateChanges);
    if (!target) {
      const liveState = await this.optionalLiveState();
      target = contextTarget(undefined, liveState ? [
        { kind: "active-sequence-changed", revision: liveState.revision, state: liveState },
      ] : []);
    }
    const provenance = contextProvenanceSet(identity.backend, capabilities, target, {
      timeline,
      stateChanges,
      assetChanges,
    });
    return {
      from: revision,
      to,
      cursor: { revision: to, ...(target ? { target } : {}) },
      provenance,
      changedScopes: changedScopes(timeline, stateChanges, assetChanges),
      timeline,
      stateChanges: dedupeStateChanges(stateChanges),
      assetChanges,
    };
  }

  private async validateCursorTarget(revision: ContextRevision, target: ContextTarget): Promise<void> {
    const revisionTarget = contextTarget(this.snapshots.get(revision.id), []);
    if (revisionTarget) {
      if (!sameContextTarget(revisionTarget, target)) {
        throw new Error(`TARGET_MISMATCH: cursor target ${formatContextTarget(target)} does not match revision target ${formatContextTarget(revisionTarget)}`);
      }
      return;
    }

    const liveState = await this.optionalLiveState();
    const activeTarget = contextTarget(undefined, liveState ? [
      { kind: "active-sequence-changed", revision: liveState.revision, state: liveState },
    ] : []);
    if (!activeTarget || !sameContextTarget(activeTarget, target)) {
      throw new Error(`TARGET_MISMATCH: cursor target ${formatContextTarget(target)} does not match the active target`);
    }
  }

  public async inspectContext(capabilities: RuntimeCapabilities): Promise<AgentContext> {
    const identity = await this.editor.getIdentity();
    const project = canonicalTimelineAvailable(capabilities)
      ? await this.inspectProject()
      : undefined;
    const editorState = await this.optionalLiveState();
    const revision = project?.revision ?? editorState?.revision;
    if (!revision) throw new Error("CAPABILITY_UNAVAILABLE: context revision");
    const target = contextTarget(project, editorState ? [
      { kind: "active-sequence-changed", revision: editorState.revision, state: editorState },
    ] : []);
    const provenance = primaryContextProvenance(identity.backend, capabilities, target);
    const cursor: ContextCursor = { revision, ...(target ? { target } : {}) };
    return {
      revision,
      cursor,
      provenance,
      changedScopes: [],
      ...(project ? { project } : {}),
      ...(editorState ? { editorState } : {}),
      media: project?.media ?? [],
      recentChanges: {
        from: revision,
        to: revision,
        cursor,
        provenance: [provenance],
        changedScopes: [],
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

function canonicalTimelineAvailable(capabilities: RuntimeCapabilities): boolean {
  return Boolean(
    capabilities.editor.projectRead
    && capabilities.editor.timelineSnapshotRead
    && capabilities.editor.canonicalTimelineMode !== "metadata-only",
  );
}

function primaryContextProvenance(
  provider: string,
  capabilities: RuntimeCapabilities,
  target?: ContextTarget,
): ContextProvenance {
  const artifact = capabilities.editor.timelineArtifactWrite && !capabilities.editor.timelineWrite;
  const canonical = capabilities.editor.canonicalTimelineMode === "canonical-read"
    || capabilities.editor.canonicalTimelineMode === "canonical-write";
  const headedNative = canonical && provider.includes("native");
  const source = provider === "fixture"
    ? "deterministic-fixture" as const
    : artifact
      ? "fcpxml-artifact" as const
      : canonical
        ? "canonical-timeline" as const
        : "live-metadata" as const;
  const evidenceTier = source === "deterministic-fixture"
    ? "deterministic" as const
    : source === "fcpxml-artifact"
      ? "fcpxml-artifact" as const
      : headedNative
        ? "headed-native" as const
      : source === "canonical-timeline"
        ? "canonical-live" as const
        : "metadata-only" as const;
  return {
    source,
    provider,
    evidenceTier,
    ...(target ? { target } : {}),
  };
}

function contextProvenanceSet(
  provider: string,
  capabilities: RuntimeCapabilities,
  target: ContextTarget | undefined,
  changes: {
    timeline?: TimelineDiff;
    stateChanges: EditorChange[];
    assetChanges: ContextDiff["assetChanges"];
  },
): ContextProvenance[] {
  const base = primaryContextProvenance(provider, capabilities, target);
  const result: ContextProvenance[] = [];
  if (changes.timeline || changes.assetChanges.length > 0) result.push(base);
  if (changes.stateChanges.length > 0) {
    result.push({
      source: "live-metadata",
      provider,
      evidenceTier: "metadata-only",
      ...(target ? { target } : {}),
    });
  }
  if (result.length === 0) result.push(base);
  return dedupeProvenance(result);
}

function contextTarget(
  project: ProjectSnapshot | undefined,
  stateChanges: EditorChange[],
): ContextTarget | undefined {
  if (project) return { projectId: project.projectId, sequenceId: project.timeline.id };
  const state = stateChanges.at(-1)?.state;
  if (!state?.project?.id || !state.sequence?.id) return undefined;
  return { projectId: state.project.id, sequenceId: state.sequence.id };
}

function isContextCursor(value: ContextCursor | ContextRevision): value is ContextCursor {
  return "revision" in value;
}

function sameContextTarget(left: ContextTarget, right: ContextTarget): boolean {
  return left.projectId === right.projectId && left.sequenceId === right.sequenceId;
}

function formatContextTarget(target: ContextTarget): string {
  return `${target.projectId}/${target.sequenceId}`;
}

function changedScopes(
  timeline: TimelineDiff | undefined,
  stateChanges: EditorChange[],
  assetChanges: ContextDiff["assetChanges"],
): ContextChangedScope[] {
  const scopes: ContextChangedScope[] = [];
  if (timeline) scopes.push("timeline");
  if (timeline && timeline.mediaChanges.length > 0) scopes.push("media");
  if (assetChanges.length > 0) scopes.push("assets");
  for (const change of stateChanges) {
    if (change.kind === "playhead-changed") scopes.push("playhead");
    if (change.kind === "active-sequence-changed" || change.kind === "sequence-time-range-changed") {
      scopes.push("sequence");
    }
  }
  return [...new Set(scopes)];
}

function dedupeProvenance(provenance: ContextProvenance[]): ContextProvenance[] {
  const seen = new Set<string>();
  return provenance.filter((entry) => {
    const key = `${entry.source}:${entry.provider}:${entry.evidenceTier}:${entry.target?.projectId ?? ""}:${entry.target?.sequenceId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
