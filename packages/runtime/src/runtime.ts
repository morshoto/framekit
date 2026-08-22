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
  CompositeEditPreview,
  CompositeEditRequest,
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
  MusicAddRequest,
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
  WorkflowOperation,
} from "./domain/types.js";
import { DefaultVerificationEngine } from "./verification/verification.js";
import { withCanonicalTimelineMode } from "./capabilities.js";
import { canonicalSnapshotDigest } from "./snapshot-digest.js";

export class AgentVideoRuntime {
  private readonly transactions = new Map<string, EditTransaction>();
  private readonly editPreviews = new Map<string, CompositeEditPreview>();
  private readonly verificationEngine: VerificationEngine;
  private readonly context: ContextEngine;

  public constructor(
    private readonly adapter: EditorPort,
    private readonly options: {
      speechAnalyzer?: SpeechAnalyzer;
      audioAnalyzer?: AudioAnalyzer;
      visualAnalyzer?: VisualAnalyzer;
      verificationEngine?: VerificationEngine;
      now?: () => number;
      previewTtlMs?: number;
      maxActivePreviews?: number;
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
    const exactPosition = parseRational(position, "INVALID_TIMELINE_POSITION");
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.frameCapture || !this.adapter.captureFrame) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline frame capture");
    }
    if (options.analyze && !this.options.visualAnalyzer) {
      throw new Error("CAPABILITY_UNAVAILABLE: visual analysis");
    }
    const project = await this.inspectProject();
    const source = await this.adapter.captureFrame(position, project.revision);
    const clip = project.timeline.clips
      .filter((candidate) => isWithinClip(exactPosition, candidate.startTime, candidate.durationTime))
      .sort((left, right) => right.track - left.track)[0];
    let analysis: VisualAnalysis | undefined;
    if (options.analyze) {
      const media = clip?.mediaId
        ? project.media.find((candidate) => candidate.mediaId === clip.mediaId)
        : undefined;
      if (!clip || !media) {
        throw new Error("CAPABILITY_UNAVAILABLE: visual analysis requires media at the captured position");
      }
      const mediaTime = rationalDifferenceSeconds(
        exactPosition,
        parseRational(clip.startTime, "INVALID_PROJECT_STATE"),
      );
      analysis = await this.options.visualAnalyzer!.analyze(
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
    const capabilities = withCanonicalTimelineMode(await this.adapter.getCapabilities());
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
    if (
      !capabilities.editor.timelineSnapshotRead
      || !capabilities.editor.readAfterWrite
      || !capabilities.editor.rollback
    ) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation requires snapshot, read-after-write, and rollback");
    }
    const appliedRevision = await this.adapter.apply(operation, before.revision);
    let attemptedAfter: ProjectSnapshot;
    try {
      attemptedAfter = await this.inspectProject();
    } catch (readError) {
      try {
        await this.adapter.restore(before, appliedRevision);
        this.assertRestored(before, await this.inspectProject());
      } catch (rollbackError) {
        throw new Error(`READ_AFTER_WRITE_FAILED: compensating rollback failed (${String(readError)}; ${String(rollbackError)})`);
      }
      throw new Error(`READ_AFTER_WRITE_FAILED: canonical state was restored (${String(readError)})`);
    }
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
      this.assertRestored(before, await this.inspectProject());
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    try {
      transaction.verification = await this.verificationEngine.verify(transaction, policy);
    } catch (verificationError) {
      try {
        await this.adapter.restore(before, attemptedAfter.revision);
        this.assertRestored(before, await this.inspectProject());
      } catch (rollbackError) {
        throw new Error(`VERIFICATION_FAILED: compensating rollback failed (${String(verificationError)}; ${String(rollbackError)})`);
      }
      throw new Error(`VERIFICATION_FAILED: canonical state was restored (${String(verificationError)})`);
    }
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      await this.adapter.restore(before, attemptedAfter.revision);
      transaction.after = await this.inspectProject();
      this.assertRestored(before, transaction.after);
      transaction.status = "ROLLED_BACK";
    }
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  public async previewEdit(request: CompositeEditRequest): Promise<CompositeEditPreview> {
    const before = await this.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    if (request.operations.length === 0) throw new Error("INVALID_OPERATION: composite edit requires operations");
    await this.assertCompositeCapabilities(request.operations);
    if (!this.adapter.previewTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction preview");
    }
    const expectedAfter = await this.adapter.previewTransaction(request.operations, before.revision);
    const previewToken = `preview-${randomUUID()}`;
    const preview: CompositeEditPreview = {
      previewToken,
      baseRevision: structuredClone(before.revision),
      operations: structuredClone(request.operations),
      expectedDiff: diffSnapshots(before, expectedAfter),
      warnings: [],
      expiresAt: new Date(this.now() + (this.options.previewTtlMs ?? 30_000)).toISOString(),
    };
    this.pruneEditPreviews();
    const maxActivePreviews = Number.isInteger(this.options.maxActivePreviews)
      && this.options.maxActivePreviews! > 0
      ? this.options.maxActivePreviews!
      : 128;
    while (this.editPreviews.size >= maxActivePreviews) {
      const oldestToken = this.editPreviews.keys().next().value;
      if (oldestToken === undefined) break;
      this.editPreviews.delete(oldestToken);
    }
    this.editPreviews.set(previewToken, preview);
    return structuredClone(preview);
  }

  public async executeEdit(previewToken: string, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const preview = this.editPreviews.get(previewToken);
    if (!preview) throw new Error(`PREVIEW_TOKEN_INVALID: unknown or already used preview ${previewToken}`);
    this.editPreviews.delete(previewToken);
    if (this.now() > Date.parse(preview.expiresAt)) {
      throw new Error("PREVIEW_TOKEN_EXPIRED: composite edit preview has expired");
    }
    const before = await this.inspectProject();
    if (!sameRevision(preview.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    await this.assertCompositeCapabilities(preview.operations);
    if (!this.adapter.applyTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction execution");
    }
    try {
      await this.adapter.applyTransaction(preview.operations, before.revision);
    } catch (error) {
      const partiallyApplied = await this.inspectProject();
      if (!sameRevision(partiallyApplied.revision, before.revision)) {
        try {
          await this.adapter.restore(before, partiallyApplied.revision);
        } catch (rollbackError) {
          throw new Error(`TRANSACTION_FAILED: ${String(error)}; rollback failed: ${String(rollbackError)}`);
        }
      }
      throw new Error(`TRANSACTION_FAILED: ${String(error)}; transaction was rolled back`);
    }
    const attemptedAfter = await this.inspectProject();
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
      intent: "composite-edit",
      planned: structuredClone(preview.operations),
      applied: structuredClone(preview.operations),
      baseRevision: before.revision,
      before,
      after: attemptedAfter,
      attemptedAfter,
      diff: diffSnapshots(before, attemptedAfter),
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

  public async previewMusic(request: MusicAddRequest): Promise<CompositeEditPreview> {
    if (request.ducking?.enabled) {
      throw new Error("CAPABILITY_UNAVAILABLE: dialogue ducking");
    }
    const before = await this.inspectProject();
    const operations: WorkflowOperation[] = [];
    const hasMediaId = request.mediaId !== undefined;
    const hasImport = request.import !== undefined;
    if (hasMediaId === hasImport) {
      throw new Error("INVALID_OPERATION: music requires exactly one mediaId or import source");
    }
    if (!Number.isInteger(request.targetLane) || request.targetLane === 0) {
      throw new Error("INVALID_OPERATION: music requires a non-primary target lane");
    }
    if (request.placement === "append" && request.start !== undefined) {
      throw new Error("INVALID_OPERATION: appended music cannot specify a start position");
    }
    const mediaId = request.import?.mediaId ?? request.mediaId!;
    if (request.import) {
      operations.push({
        type: "media.import",
        mediaId: request.import.mediaId,
        source: request.import.source,
        mediaKind: "audio",
        duration: request.import.duration,
        sourceDigest: request.import.sourceDigest,
      });
    }
    const media = before.media.find((candidate) => candidate.mediaId === mediaId);
    const duration = request.duration ?? request.import?.duration ?? media?.duration;
    if (duration === undefined) {
      throw new Error("INVALID_OPERATION: music duration is required when media duration is unavailable");
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("INVALID_OPERATION: music duration must be positive");
    }
    const start = request.placement === "append" ? before.timeline.duration : request.start;
    if (start === undefined || !Number.isFinite(start) || start < 0) {
      throw new Error("INVALID_OPERATION: inserted music requires a non-negative start position");
    }
    operations.push({
      type: "timeline.media.add",
      occurrenceId: request.occurrenceId,
      mediaId,
      role: "music",
      start,
      duration,
      targetLane: request.targetLane,
    });
    if (request.gainDb !== undefined) {
      if (!Number.isFinite(request.gainDb)) throw new Error("INVALID_OPERATION: music gain must be finite");
      operations.push({ type: "set-gain", clipId: request.occurrenceId, gainDb: request.gainDb });
    }
    if (request.fadeIn !== undefined || request.fadeOut !== undefined) {
      const fadeIn = request.fadeIn ?? 0;
      const fadeOut = request.fadeOut ?? 0;
      if (!Number.isFinite(fadeIn) || !Number.isFinite(fadeOut) || fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > duration) {
        throw new Error("INVALID_OPERATION: music fades must be non-negative and fit within the music duration");
      }
      operations.push({
        type: "timeline.audio.fades",
        clipId: request.occurrenceId,
        fadeIn,
        fadeOut,
      });
    }
    return this.previewEdit({ baseRevision: request.baseRevision, operations });
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
    const restored = await this.inspectProject();
    this.assertRestored(transaction.before, restored);
    return restored;
  }

  private assertRestored(expected: ProjectSnapshot, actual: ProjectSnapshot): void {
    if (canonicalSnapshotDigest(expected) !== canonicalSnapshotDigest(actual)) {
      throw new Error("ROLLBACK_FAILED: restored canonical digest does not match pre-edit state");
    }
  }

  private liveAdapter(): LiveEditorStatePort {
    const candidate = this.adapter as Partial<LiveEditorStatePort>;
    if (typeof candidate.readLiveState !== "function" || typeof candidate.liveChangesSince !== "function") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut editor state");
    }
    return candidate as LiveEditorStatePort;
  }

  private async assertCompositeCapabilities(operations: WorkflowOperation[]): Promise<void> {
    const capabilities = (await this.adapter.getCapabilities()).editor;
    if (!capabilities.compositeTransactions || !capabilities.readAfterWrite || !capabilities.rollback) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transactions");
    }
    if (operations.some((operation) => operation.type === "media.import") && !capabilities.mediaImport) {
      throw new Error("CAPABILITY_UNAVAILABLE: media import");
    }
    if (operations.some((operation) => operation.type === "timeline.media.add") && !capabilities.mediaPlacement) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media placement");
    }
    if (operations.some((operation) => operation.type === "timeline.title.add")
      && (!capabilities.titlePlacement || !capabilities.assetDiscovery)) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline title placement");
    }
    if (operations.some((operation) => operation.type !== "media.import")
      && !capabilities.timelineWrite && !capabilities.timelineArtifactWrite) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneEditPreviews(): void {
    const now = this.now();
    for (const [previewToken, preview] of this.editPreviews) {
      if (now > Date.parse(preview.expiresAt)) this.editPreviews.delete(previewToken);
    }
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

interface RationalParts {
  value: bigint;
  timescale: bigint;
}

function parseRational(time: RationalTime, errorCode: string): RationalParts {
  if (!/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale)) {
    throw new Error(`${errorCode}: rational time requires integer value and timescale`);
  }
  const value = BigInt(time.value);
  const timescale = BigInt(time.timescale);
  if (timescale <= 0n) throw new Error(`${errorCode}: rational timescale must be positive`);
  return { value, timescale };
}

function isWithinClip(
  position: RationalParts,
  startTime: RationalTime,
  durationTime: RationalTime,
): boolean {
  const start = parseRational(startTime, "INVALID_PROJECT_STATE");
  const duration = parseRational(durationTime, "INVALID_PROJECT_STATE");
  if (duration.value < 0n) throw new Error("INVALID_PROJECT_STATE: clip duration cannot be negative");
  const startsBeforeOrAtPosition = start.value * position.timescale <= position.value * start.timescale;
  const endValue = start.value * duration.timescale + duration.value * start.timescale;
  const endTimescale = start.timescale * duration.timescale;
  const positionBeforeEnd = position.value * endTimescale < endValue * position.timescale;
  return startsBeforeOrAtPosition && positionBeforeEnd;
}

function rationalDifferenceSeconds(left: RationalParts, right: RationalParts): number {
  const numerator = left.value * right.timescale - right.value * left.timescale;
  const denominator = left.timescale * right.timescale;
  const seconds = Number(numerator) / Number(denominator);
  if (!Number.isFinite(seconds)) {
    throw new Error("INVALID_TIMELINE_POSITION: relative media time is outside the supported analysis range");
  }
  return seconds;
}
