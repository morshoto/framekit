import { randomUUID } from "node:crypto";
import { ContextEngine } from "./context/context-engine.js";
import { diffSnapshots } from "./diff/diff.js";
import type {
  AgentContext,
  AudioAnalysis,
  AudioAnalyzer,
  AssetSearchQuery,
  ContextDiff,
  ContextRevision,
  EditOperation,
  EditTransaction,
  EditorPort,
  EditorAsset,
  EditorChange,
  EditorLiveState,
  RationalTime,
  LiveEditorStatePort,
  MediaContext,
  MediaUnderstanding,
  ProjectSnapshot,
  ProjectCatalog,
  ProjectSelection,
  SpeechAnalysis,
  SpeechAnalyzer,
  TimelineDiff,
  TimelineFrameCapture,
  TimeRange,
  VisualAnalysis,
  VisualAnalyzer,
  VerificationEngine,
  VerificationPolicy,
} from "./domain/types.js";
import { DefaultVerificationEngine } from "./verification/verification.js";

export class AgentVideoRuntime {
  private readonly transactions = new Map<string, EditTransaction>();
  private readonly verificationEngine: VerificationEngine;
  private readonly context: ContextEngine;

  public constructor(
    private readonly adapter: EditorPort,
    private readonly options: {
      speechAnalyzer?: SpeechAnalyzer;
      audioAnalyzer?: AudioAnalyzer;
      visualAnalyzer?: VisualAnalyzer;
      verificationEngine?: VerificationEngine;
    } = {},
  ) {
    this.context = new ContextEngine(adapter);
    this.verificationEngine = options.verificationEngine ?? new DefaultVerificationEngine();
  }

  public async inspectProject(): Promise<ProjectSnapshot> {
    return this.context.inspectProject();
  }

  public async inspectTimeline(): Promise<ProjectSnapshot["timeline"]> {
    const project = await this.inspectProject();
    return project.timeline;
  }

  public async captureFrame(
    position: RationalTime,
    options: { analyze?: boolean } = {},
  ): Promise<TimelineFrameCapture> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.frameCapture || !this.adapter.captureFrame) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline frame capture");
    }
    const project = await this.inspectProject();
    const source = await this.adapter.captureFrame(position);
    const positionSeconds = rationalSeconds(position);
    const clip = project.timeline.clips
      .filter((candidate) => candidate.start <= positionSeconds && candidate.start + candidate.duration > positionSeconds)
      .sort((left, right) => right.track - left.track)[0];
    let analysis: VisualAnalysis | undefined;
    if (options.analyze) {
      if (!this.options.visualAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: visual analysis");
      const media = clip?.mediaId
        ? project.media.find((candidate) => candidate.mediaId === clip.mediaId)
        : undefined;
      if (!clip || !media) {
        throw new Error("CAPABILITY_UNAVAILABLE: visual analysis requires media at the captured position");
      }
      const mediaTime = positionSeconds - clip.start;
      analysis = await this.options.visualAnalyzer.analyze(
        { project, media },
        { start: mediaTime, end: mediaTime },
      );
    }
    return {
      image: structuredClone(source.image),
      position: { ...position },
      timecode: source.timecode,
      project: { id: project.projectId, name: project.projectName },
      sequence: { id: project.timeline.id, name: project.timeline.name },
      ...(clip ? {
        clip: {
          id: clip.id,
          ...(clip.mediaId ? { mediaId: clip.mediaId } : {}),
          name: clip.name,
          startTime: { ...clip.startTime },
          durationTime: { ...clip.durationTime },
          track: clip.track,
        },
      } : {}),
      ...(analysis ? { analysis } : {}),
    };
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.projectCatalogRead || !this.adapter.listProjects) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor project catalog");
    }
    return this.adapter.listProjects();
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.projectSelection || !this.adapter.selectProject) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor project selection");
    }
    if (!selection.projectId.trim()) throw new Error("INVALID_PROJECT_SELECTION: projectId is required");
    if (selection.sequenceId !== undefined && !selection.sequenceId.trim()) {
      throw new Error("INVALID_PROJECT_SELECTION: sequenceId cannot be empty");
    }
    return this.adapter.selectProject(selection);
  }

  public async inspectEditor() {
    const capabilities = await this.adapter.getCapabilities();
    return {
      identity: await this.adapter.getIdentity(),
      capabilities: {
        ...capabilities,
        analyzers: {
          ...capabilities.analyzers,
          speechTranscribe: capabilities.analyzers.speechTranscribe || Boolean(this.options.speechAnalyzer),
          audioLoudness: capabilities.analyzers.audioLoudness || Boolean(this.options.audioAnalyzer),
          visualTrack: capabilities.analyzers.visualTrack || Boolean(this.options.visualAnalyzer),
        },
      },
    };
  }

  public async inspectContext(): Promise<AgentContext> {
    const editor = await this.inspectEditor();
    return this.context.inspectContext(editor.capabilities);
  }

  public async inspectLiveEditor(): Promise<EditorLiveState> {
    const liveAdapter = this.liveAdapter();
    return liveAdapter.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    const liveAdapter = this.liveAdapter();
    return liveAdapter.liveChangesSince(revision, waitMs);
  }

  public async edit(operation: EditOperation, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const before = await this.inspectProject();
    if (operation.baseRevision && !sameRevision(operation.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: operation base revision does not match current editor state");
    }

    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.timelineWrite && !capabilities.editor.timelineArtifactWrite) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
    }
    await this.adapter.apply(operation, before.revision);
    const attemptedAfter = await this.inspectProject();
    const diff = diffSnapshots(before, attemptedAfter);
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
      operation,
      intent: operation.type,
      planned: [operation],
      applied: [operation],
      baseRevision: before.revision,
      before,
      after: attemptedAfter,
      attemptedAfter,
      diff,
      status: "APPLIED",
    };
    try {
      transaction.attemptedAfter = await this.reanalyzeAffectedRanges(transaction);
      transaction.after = transaction.attemptedAfter;
    } catch (error) {
      await this.adapter.restore(before, attemptedAfter.revision);
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    transaction.verification = await this.verificationEngine.verify(transaction, policy);
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      await this.adapter.restore(before, attemptedAfter.revision);
      transaction.after = await this.inspectProject();
      transaction.status = "ROLLED_BACK";
    }
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  public async changesSince(revision: ContextRevision): Promise<TimelineDiff> {
    return this.context.changesSince(revision);
  }

  public async contextChangesSince(revision: ContextRevision, waitMs = 0): Promise<ContextDiff> {
    return this.context.contextChangesSince(revision, waitMs);
  }

  public async analyzeSpeech(mediaId: string): Promise<SpeechAnalysis> {
    if (!this.options.speechAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
    const project = await this.inspectProject();
    const media = project.media.find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    return this.options.speechAnalyzer.analyze({ project, media });
  }

  public async analyzeAudio(mediaId: string): Promise<AudioAnalysis> {
    if (!this.options.audioAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
    const project = await this.inspectProject();
    const media = project.media.find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    return this.options.audioAnalyzer.analyze({ project, media });
  }

  public async analyzeVisual(mediaId: string, range?: TimeRange): Promise<VisualAnalysis> {
    if (!this.options.visualAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: visual analysis");
    const project = await this.inspectProject();
    const media = project.media.find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    return this.options.visualAnalyzer.analyze({ project, media }, range);
  }

  public async understandMedia(mediaId: string): Promise<MediaUnderstanding> {
    const project = await this.inspectProject();
    const media = project.media.find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    const input = { project, media };
    const [speech, audio, visual] = await Promise.all([
      this.options.speechAnalyzer?.analyze(input),
      this.options.audioAnalyzer?.analyze(input),
      this.options.visualAnalyzer?.analyze(input),
    ]);
    if (!speech && !audio && !visual) {
      throw new Error("CAPABILITY_UNAVAILABLE: media understanding");
    }
    const understanding: MediaUnderstanding = {
      mediaId: media.mediaId,
      source: media.source,
      ...(speech ? { speech } : {}),
      ...(audio ? { audio } : {}),
      ...(visual ? { visual } : {}),
      analysisRevision: project.revision,
    };
    this.context.attachMediaUnderstanding(understanding);
    return structuredClone(understanding);
  }

  public async inspectMedia(mediaId: string): Promise<MediaContext> {
    const project = await this.inspectProject();
    const media = project.media.find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    return media;
  }

  public async searchMedia(query: string): Promise<MediaContext[]> {
    const project = await this.inspectProject();
    const normalized = query.trim().toLowerCase();
    return project.media.filter((media) =>
      media.mediaId.toLowerCase().includes(normalized) || media.source.toLowerCase().includes(normalized),
    );
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.assetDiscovery || !this.adapter.listAssets) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor assets");
    }
    const assets = await this.context.listAssets(query);
    return assets.filter((asset) => matchesAssetQuery(asset, query));
  }

  public getDiff(transactionId: string): TimelineDiff {
    const transaction = this.getTransaction(transactionId);
    return transaction.diff;
  }

  public getTransaction(transactionId: string): EditTransaction {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error(`TRANSACTION_NOT_FOUND: ${transactionId}`);
    }
    return transaction;
  }

  public async verifyTransaction(transactionId: string): Promise<NonNullable<EditTransaction["verification"]>> {
    return this.getTransaction(transactionId).verification!;
  }

  public async undo(transactionId: string): Promise<ProjectSnapshot> {
    const transaction = this.getTransaction(transactionId);
    const current = await this.inspectProject();
    if (
      current.projectId !== transaction.before.projectId
      || current.timeline.id !== transaction.before.timeline.id
    ) {
      throw new Error(
        `TARGET_MISMATCH: cannot undo ${transaction.before.projectId}/${transaction.before.timeline.id} while ${current.projectId}/${current.timeline.id} is active`,
      );
    }
    await this.adapter.restore(transaction.before, current.revision);
    return this.inspectProject();
  }

  private liveAdapter(): LiveEditorStatePort {
    const candidate = this.adapter as Partial<LiveEditorStatePort>;
    if (typeof candidate.readLiveState !== "function" || typeof candidate.liveChangesSince !== "function") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
    }
    return candidate as LiveEditorStatePort;
  }

  private async reanalyzeAffectedRanges(transaction: EditTransaction): Promise<ProjectSnapshot> {
    const mediaIds = new Set(transaction.diff.affectedRanges.flatMap((range) =>
      transaction.attemptedAfter.timeline.clips
        .filter((clip) => clip.start < range.end && clip.start + clip.duration > range.start)
        .flatMap((clip) => clip.mediaId ? [clip.mediaId] : []),
    ));
    if (mediaIds.size === 0) return transaction.attemptedAfter;
    const next = structuredClone(transaction.attemptedAfter);
    for (const mediaId of mediaIds) {
      const media = next.media.find((candidate) => candidate.mediaId === mediaId);
      if (!media) continue;
      const ranges = transaction.diff.affectedRanges.filter((range) =>
        next.timeline.clips.some((clip) => clip.mediaId === mediaId && clip.start < range.end && clip.start + clip.duration > range.start),
      );
      const input = { project: next, media };
      if (this.options.speechAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.speechAnalyzer!.analyze(input, range)));
        media.speech = { words: analyses.flatMap((analysis) => analysis.words) };
      }
      if (this.options.audioAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.audioAnalyzer!.analyze(input, range)));
        if (analyses[analyses.length - 1]) media.audio = analyses[analyses.length - 1];
      }
      if (this.options.visualAnalyzer) {
        const analyses = await Promise.all(ranges.map((range) => this.options.visualAnalyzer!.analyze(input, range)));
        media.visual = {
          scenes: analyses.flatMap((analysis) => analysis.scenes),
          subjects: analyses.flatMap((analysis) => analysis.subjects),
          keyframes: analyses.flatMap((analysis) => analysis.keyframes),
          motion: analyses[analyses.length - 1]?.motion,
        };
      }
      if (this.options.speechAnalyzer || this.options.audioAnalyzer || this.options.visualAnalyzer) {
        for (const candidate of next.media) {
          if (candidate.mediaId === mediaId) candidate.analysisRevision = next.revision.id;
        }
      }
    }
    return next;
  }
}

function matchesAssetQuery(asset: EditorAsset, query?: AssetSearchQuery): boolean {
  if (!query) return true;
  const normalized = query.query?.trim().toLowerCase();
  if (normalized && ![asset.id, asset.name, asset.vendor].some((value) => value.toLowerCase().includes(normalized))) return false;
  if (query.kind && asset.kind !== query.kind) return false;
  if (query.vendor && asset.vendor.toLowerCase() !== query.vendor.trim().toLowerCase()) return false;
  return true;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function rationalSeconds(time: RationalTime): number {
  const value = Number(time.value);
  const timescale = Number(time.timescale);
  if (!Number.isFinite(value) || !Number.isFinite(timescale) || timescale <= 0) {
    throw new Error("INVALID_TIMELINE_POSITION: position must be a valid rational time");
  }
  return value / timescale;
}
