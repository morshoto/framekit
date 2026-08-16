import { randomUUID } from "node:crypto";
import { ContextEngine } from "./context/context-engine.js";
import { diffSnapshots } from "./diff/diff.js";
import type {
  AudioAnalysis,
  AudioAnalyzer,
  ContextRevision,
  EditOperation,
  EditTransaction,
  EditorPort,
  EditorAsset,
  EditorChange,
  EditorLiveState,
  LiveEditorStatePort,
  MediaContext,
  ProjectSnapshot,
  SpeechAnalysis,
  SpeechAnalyzer,
  TimelineDiff,
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
        },
      },
    };
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

  public async listAssets(): Promise<EditorAsset[]> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.assetDiscovery || !this.adapter.listAssets) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor assets");
    }
    return this.adapter.listAssets();
  }

  public async analyzeVisual(): Promise<never> {
    throw new Error("CAPABILITY_UNAVAILABLE: visual analysis is Phase 2");
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
    }
    return next;
  }
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
