import { randomUUID } from "node:crypto";
import { ContextEngine } from "../context/context-engine.js";
import { diffSnapshots } from "./diff.js";
import type {
  AudioAnalysis,
  AudioAnalyzer,
  ContextRevision,
  EditOperation,
  EditTransaction,
  EditorPort,
  EditorAsset,
  FinalCutLiveChange,
  FinalCutLivePort,
  FinalCutLiveState,
  MediaContext,
  ProjectSnapshot,
  SpeechAnalysis,
  SpeechAnalyzer,
  TimelineDiff,
  VerificationEngine,
  VerificationPolicy,
} from "./types.js";
import { DefaultVerificationEngine } from "./verification.js";

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
    return {
      identity: await this.adapter.getIdentity(),
      capabilities: await this.adapter.getCapabilities(),
    };
  }

  public async inspectLiveEditor(): Promise<FinalCutLiveState> {
    const liveAdapter = this.liveAdapter();
    return liveAdapter.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<FinalCutLiveChange[]> {
    const liveAdapter = this.liveAdapter();
    return liveAdapter.liveChangesSince(revision, waitMs);
  }

  public async edit(operation: EditOperation, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const before = await this.inspectProject();
    if (operation.baseRevision && !sameRevision(operation.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: operation base revision does not match current editor state");
    }

    await this.adapter.apply(operation, before.revision);
    const attemptedAfter = await this.inspectProject();
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
      diff: diffSnapshots(before, attemptedAfter),
      status: "APPLIED",
    };
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
    if (!capabilities.assetDiscovery || !this.adapter.listAssets) {
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

  private liveAdapter(): FinalCutLivePort {
    const candidate = this.adapter as Partial<FinalCutLivePort>;
    if (typeof candidate.readLiveState !== "function" || typeof candidate.liveChangesSince !== "function") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
    }
    return candidate as FinalCutLivePort;
  }
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
