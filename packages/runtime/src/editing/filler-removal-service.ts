import { randomUUID } from "node:crypto";
import { diffSnapshots } from "../timeline/snapshot-diff.js";
import type { EditorPort } from "../domain/ports.js";
import type { EditOperation, EditTransaction } from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { SpeechWord } from "../domain/media.js";
import type { TimeRange } from "../domain/primitives.js";
import type { VerificationCheck, VerificationEngine } from "../domain/verification.js";
import type {
  FillerRemovalPreview,
  FillerRemovalRequest,
  FillerRemovalTarget,
} from "../speech/filler-removal.js";
import { sameRevision } from "../context/revision.js";
import { translateRationalRange } from "../timeline/rational-time.js";
import { canonicalSnapshotDigest } from "../timeline/snapshot-digest.js";
import { planFillerRemoval } from "../speech/filler-removal.js";
import { ProjectService } from "../application/project-service.js";
import type { RuntimeOptions } from "../application/runtime-options.js";
import { TransactionStore } from "../application/transaction-store.js";

export class FillerRemovalService {
  private readonly previews = new Map<string, FillerRemovalPreviewRecord>();

  public constructor(
    private readonly adapter: EditorPort,
    private readonly project: ProjectService,
    private readonly verificationEngine: VerificationEngine,
    private readonly options: RuntimeOptions,
    private readonly transactions: TransactionStore,
  ) {}

  public async previewFillerRemoval(request: FillerRemovalRequest): Promise<FillerRemovalPreview> {
    const before = await this.project.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: filler preview base revision does not match current editor state");
    }
    await this.assertCapabilities();
    const selectedRange = validateFillerSelection(request.range);
    const candidates: FillerRemovalTarget[] = [];
    const analysisRangesByClip = new Map<string, TimeRange>();
    const selectedClips = before.timeline.clips.filter((clip) =>
      clip.mediaId && rangesOverlap(clip.start, clip.start + clip.duration, selectedRange.start, selectedRange.end),
    );
    const selectedMediaIds = new Set<string>();
    for (const clip of selectedClips) {
      if (clip.mediaId && selectedMediaIds.has(clip.mediaId)) {
        throw new Error("CAPABILITY_UNAVAILABLE: filler removal cannot verify repeated timeline occurrences of the same media item");
      }
      if (clip.mediaId) selectedMediaIds.add(clip.mediaId);
    }
    for (const clip of selectedClips) {
      if (!clip.mediaId) continue;
      const media = before.media.find((candidate) => candidate.mediaId === clip.mediaId);
      if (!media) throw new Error(`MEDIA_NOT_FOUND: ${clip.mediaId}`);
      const localRange = {
        start: Math.max(0, selectedRange.start - clip.start),
        end: Math.min(clip.duration, selectedRange.end - clip.start),
      };
      if (localRange.end <= localRange.start) continue;
      const speech = await this.options.speechAnalyzer!.analyze({ project: before, media }, localRange);
      analysisRangesByClip.set(clip.id, structuredClone(localRange));
      for (const candidate of planFillerRemoval(speech.words, localRange, request)) {
        candidates.push({
          ...candidate,
          clipId: clip.id,
          mediaId: clip.mediaId,
          sourceRange: structuredClone(candidate.range),
          range: translateRationalRange(clip.startTime, clip.start, candidate.range),
        });
      }
    }
    if (candidates.length === 0) {
      throw new Error("NO_FILLERS_FOUND: no high-confidence filler words in selected range");
    }
    candidates.sort((left, right) => right.range.start - left.range.start);
    const operations: EditOperation[] = candidates.map((candidate) => ({
      type: "ripple-delete",
      timelineId: before.timeline.id,
      range: structuredClone(candidate.range),
      reason: `remove high-confidence filler word: ${candidate.word.text}`,
    }));
    const previewToken = `filler-preview-${randomUUID()}`;
    const expiresAt = new Date(this.now() + (this.options.previewTtlMs ?? 30_000)).toISOString();
    const expectedDiff = this.adapter.previewTransaction
      ? diffSnapshots(before, await this.adapter.previewTransaction(operations, before.revision))
      : undefined;
    const preview: FillerRemovalPreview = {
      previewToken,
      baseRevision: structuredClone(before.revision),
      range: structuredClone(selectedRange),
      candidates: structuredClone(candidates),
      operations: structuredClone(operations),
      ...(expectedDiff ? { expectedDiff } : {}),
      warnings: expectedDiff ? [] : ["The selected canonical editor has no non-mutating preview provider; the diff will be observed after execution."],
      expiresAt,
    };
    this.prunePreviews();
    const maxActivePreviews = Number.isInteger(this.options.maxActivePreviews) && this.options.maxActivePreviews! > 0
      ? this.options.maxActivePreviews!
      : 128;
    while (this.previews.size >= maxActivePreviews) {
      const oldestToken = this.previews.keys().next().value;
      if (oldestToken === undefined) break;
      this.previews.delete(oldestToken);
    }
    this.previews.set(previewToken, { preview, analysisRangesByClip });
    return structuredClone(preview);
  }

  public async executeFillerRemoval(previewToken: string): Promise<EditTransaction> {
    const record = this.previews.get(previewToken);
    if (!record) throw new Error(`PREVIEW_TOKEN_INVALID: unknown or already used filler preview ${previewToken}`);
    this.previews.delete(previewToken);
    if (this.now() > Date.parse(record.preview.expiresAt)) {
      throw new Error("PREVIEW_TOKEN_EXPIRED: filler removal preview has expired");
    }
    const before = await this.project.inspectProject();
    if (!sameRevision(record.preview.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: filler preview base revision does not match current editor state");
    }
    await this.assertCapabilities();
    let current = before;
    let currentRevision = before.revision;
    try {
      for (const operation of record.preview.operations) {
        currentRevision = await this.adapter.apply(operation, currentRevision);
        current = await this.project.inspectProject();
        if (!sameRevision(current.revision, currentRevision)) {
          throw new Error("READ_AFTER_WRITE_FAILED: editor returned an unexpected filler-removal revision");
        }
      }
      const transaction: EditTransaction = {
        id: `txn-${randomUUID()}`,
        intent: "remove-filler-words",
        planned: structuredClone(record.preview.operations),
        applied: structuredClone(record.preview.operations),
        baseRevision: before.revision,
        before,
        after: current,
        attemptedAfter: current,
        diff: diffSnapshots(before, current),
        status: "APPLIED",
      };
      transaction.attemptedAfter = await this.reanalyzeFillerTargets(transaction, record);
      transaction.after = transaction.attemptedAfter;
      const structuralVerification = await this.verificationEngine.verify(transaction, { requireExpectedChange: true });
      const continuity = verifyFillerSpeechContinuity(transaction, record);
      transaction.verification = {
        passed: structuralVerification.passed && continuity.passed,
        checks: [...structuralVerification.checks, continuity],
      };
      if (transaction.verification.passed) {
        transaction.status = "VERIFIED";
      } else {
        await this.adapter.restore(before, current.revision);
        transaction.after = await this.project.inspectProject();
        this.assertRestored(before, transaction.after);
        transaction.status = "ROLLED_BACK";
      }
      this.transactions.set(transaction);
      return transaction;
    } catch (error) {
      let partiallyApplied: ProjectSnapshot;
      try {
        partiallyApplied = await this.project.inspectProject();
      } catch (readError) {
        throw new Error(`FILLER_REMOVAL_FAILED: ${String(error)}; rollback failed: ${String(readError)}`);
      }
      if (!sameRevision(partiallyApplied.revision, before.revision)) {
        try {
          await this.adapter.restore(before, partiallyApplied.revision);
          this.assertRestored(before, await this.project.inspectProject());
        } catch (rollbackError) {
          throw new Error(`FILLER_REMOVAL_FAILED: ${String(error)}; rollback failed: ${String(rollbackError)}`);
        }
      }
      throw new Error(`FILLER_REMOVAL_FAILED: ${String(error)}`);
    }
  }

  private async assertCapabilities(): Promise<void> {
    if (!this.options.speechAnalyzer) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
    const capabilities = (await this.adapter.getCapabilities()).editor;
    if (!capabilities.timelineSnapshotRead || !capabilities.timelineWrite
      || !capabilities.readAfterWrite || !capabilities.rollback) {
      throw new Error("CAPABILITY_UNAVAILABLE: filler removal requires canonical timeline write, read-after-write, and rollback");
    }
  }

  private assertRestored(expected: ProjectSnapshot, actual: ProjectSnapshot): void {
    if (canonicalSnapshotDigest(expected) !== canonicalSnapshotDigest(actual)) {
      throw new Error("ROLLBACK_FAILED: restored canonical digest does not match pre-edit state");
    }
  }

  private async reanalyzeFillerTargets(
    transaction: EditTransaction,
    record: FillerRemovalPreviewRecord,
  ): Promise<ProjectSnapshot> {
    const next = structuredClone(transaction.attemptedAfter);
    const targets = new Map(record.preview.candidates.map((candidate) => [candidate.clipId, candidate]));
    for (const clipId of targets.keys()) {
      const beforeClip = transaction.before.timeline.clips.find((clip) => clip.id === clipId);
      const afterClip = next.timeline.clips.find((clip) => clip.id === clipId);
      if (!beforeClip || !afterClip || !beforeClip.mediaId) {
        throw new Error(`ANALYSIS_FAILED: filler target clip ${clipId} disappeared after the edit`);
      }
      const media = next.media.find((candidate) => candidate.mediaId === beforeClip.mediaId);
      if (!media) throw new Error(`MEDIA_NOT_FOUND: ${beforeClip.mediaId}`);
      const analysisRange = record.analysisRangesByClip.get(clipId);
      if (!analysisRange) throw new Error(`ANALYSIS_FAILED: filler analysis range for clip ${clipId} is unavailable`);
      const fillerCandidates = record.preview.candidates.filter((candidate) => candidate.clipId === clipId);
      const deletes = fillerCandidates.map((candidate) => candidate.sourceRange);
      const postEditRange = translateRangeAfterDeletes(
        analysisRange,
        deletes,
      );
      const speech = await this.options.speechAnalyzer!.analyze(
        { project: next, media },
        postEditRange,
      );
      const retainedWords = transaction.before.media
        .find((candidate) => candidate.mediaId === beforeClip.mediaId)
        ?.speech?.words ?? [];
      const translatedRetainedWords = retainedWords
        .filter((word) => !fillerCandidates.some((candidate) => sameSpeechWord(word, candidate.word)))
        .map((word) => translateSpeechWordAfterDeletes(word, deletes));
      media.speech = {
        words: [
          ...translatedRetainedWords.filter((word) => !rangesOverlap(
            word.start,
            word.end,
            postEditRange.start,
            postEditRange.end,
          )),
          ...speech.words.filter((word) => word.start >= postEditRange.start && word.end <= postEditRange.end),
        ].sort((left, right) => left.start - right.start || left.end - right.end),
      };
      media.analysisRevision = next.revision.id;
    }
    return next;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [previewToken, record] of this.previews) {
      if (now > Date.parse(record.preview.expiresAt)) this.previews.delete(previewToken);
    }
  }
}

interface FillerRemovalPreviewRecord {
  preview: FillerRemovalPreview;
  analysisRangesByClip: Map<string, TimeRange>;
}

function validateFillerSelection(range: TimeRange): TimeRange {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start) {
    throw new Error("INVALID_OPERATION: filler selection range must be positive");
  }
  return {
    start: range.start,
    end: range.end,
    ...(range.startTime ? { startTime: { ...range.startTime } } : {}),
    ...(range.durationTime ? { durationTime: { ...range.durationTime } } : {}),
  };
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function translateRangeAfterDeletes(range: TimeRange, deletes: TimeRange[]): TimeRange {
  const orderedDeletes = orderDeletes(deletes);
  return {
    start: translateBoundaryAfterDeletes(range.start, orderedDeletes),
    end: translateBoundaryAfterDeletes(range.end, orderedDeletes),
  };
}

function orderDeletes(deletes: TimeRange[]): TimeRange[] {
  return [...deletes].sort((left, right) => left.start - right.start);
}

function translateBoundaryAfterDeletes(boundary: number, deletes: TimeRange[]): number {
  let translated = boundary;
  let removed = 0;
  for (const deletion of deletes) {
    if (boundary <= deletion.start) break;
    if (boundary < deletion.end) return deletion.start - removed;
    const duration = deletion.end - deletion.start;
    translated -= duration;
    removed += duration;
  }
  return translated;
}

function translateSpeechWordAfterDeletes(word: SpeechWord, deletes: TimeRange[]): SpeechWord {
  const orderedDeletes = orderDeletes(deletes);
  return {
    ...word,
    start: translateBoundaryAfterDeletes(word.start, orderedDeletes),
    end: translateBoundaryAfterDeletes(word.end, orderedDeletes),
  };
}

function verifyFillerSpeechContinuity(
  transaction: EditTransaction,
  record: FillerRemovalPreviewRecord,
): VerificationCheck {
  const clipIds = new Set(record.preview.candidates.map((candidate) => candidate.clipId));
  for (const clipId of clipIds) {
    const beforeClip = transaction.before.timeline.clips.find((clip) => clip.id === clipId);
    const afterClip = transaction.attemptedAfter.timeline.clips.find((clip) => clip.id === clipId);
    const mediaId = beforeClip?.mediaId;
    const beforeWords = mediaId
      ? transaction.before.media.find((media) => media.mediaId === mediaId)?.speech?.words
      : undefined;
    const actualWords = mediaId
      ? transaction.attemptedAfter.media.find((media) => media.mediaId === mediaId)?.speech?.words
      : undefined;
    if (!beforeClip || !afterClip || !beforeWords || !actualWords) {
      return {
        name: "filler-speech-continuity",
        passed: false,
        detail: `complete pre- and post-edit speech analysis is unavailable for filler target clip ${clipId}`,
      };
    }
    const candidates = record.preview.candidates.filter((candidate) => candidate.clipId === clipId);
    const deletes = candidates.map((candidate) => candidate.sourceRange);
    const expectedWords = beforeWords
      .filter((word) => !candidates.some((candidate) => sameSpeechWord(candidate.word, word)))
      .map((word) => translateSpeechWordAfterDeletes(word, deletes));
    if (expectedWords.length !== actualWords.length) {
      return {
        name: "filler-speech-continuity",
        passed: false,
        detail: `post-edit transcript has ${actualWords.length} words; expected ${expectedWords.length} adjacent words after filler removal`,
      };
    }
    for (let index = 0; index < expectedWords.length; index += 1) {
      const expected = expectedWords[index]!;
      const actual = actualWords[index]!;
      if (expected.text.trim().toLowerCase() !== actual.text.trim().toLowerCase()
        || Math.abs(expected.start - actual.start) > 0.02
        || Math.abs(expected.end - actual.end) > 0.02
        || actual.end > afterClip.duration + 0.02) {
        return {
          name: "filler-speech-continuity",
          passed: false,
          detail: `post-edit transcript boundary ${index + 1} does not preserve adjacent speech around the removed fillers`,
        };
      }
    }
  }
  return {
    name: "filler-speech-continuity",
    passed: true,
    detail: "post-edit speech re-analysis preserves adjacent words and clip bounds",
  };
}

function sameSpeechWord(left: SpeechWord, right: SpeechWord): boolean {
  return left.text === right.text && left.start === right.start && left.end === right.end;
}
