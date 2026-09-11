import type { SkillDefinition, SkillPlanningContext, SkillVerificationContext } from "../domain/skills.js";
import type { TimeRange } from "../domain/primitives.js";
import type { SpeechWord } from "../domain/media.js";
import type { EditTransaction } from "../domain/editing.js";
import type { TimelineDiff } from "../domain/diff.js";
import { FillerDetector, type FillerCandidate } from "../speech/filler-detector.js";
import { SafeCutResolver, type SafeCutDecision } from "../speech/safe-cut-resolver.js";
import {
  DIALOGUE_NORMALIZATION_DEFAULTS,
  planDialogueGain,
  type DialogueNormalizationRequest,
} from "../audio/dialogue-normalization.js";
import { planNoiseReduction, type NoiseReductionRequest } from "../audio/noise-reduction.js";
import { planColorCorrection, type ColorCorrectionRequest } from "../color-correction.js";

export function builtinSkills(): SkillDefinition[] {
  return [fillerRemovalSkill(), dialogueNormalizationSkill(), noiseReductionSkill(), colorCorrectionSkill()];
}

function fillerRemovalSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "filler-removal",
      version: "1.0.0",
      title: "Filler removal",
      description: "Remove high-confidence filler words through a guarded closed-loop transaction.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              start: { type: "number", minimum: 0 },
              end: { type: "number", minimum: 0 },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          confidenceThreshold: { type: "number", minimum: 0, maximum: 1 },
          preservePauseMs: { type: "number", minimum: 0 },
          targetPauseMs: { type: "number", minimum: 0 },
          selectedCandidateIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["range"],
        additionalProperties: false,
      },
      requirements: {
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          { type: "editor", capability: "timelineWrite" },
          { type: "editor", capability: "readAfterWrite" },
          { type: "editor", capability: "rollback" },
          { type: "editor", capability: "compositeTransactions" },
          { type: "analyzer", capability: "speechTranscribe" },
          { type: "analyzer", capability: "speechVad" },
          { type: "operation", operation: "ripple-delete" },
        ],
      },
      verification: { requireExpectedChange: true, requireSpeechContinuity: true },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: async (context, input) => planFillerSkill(context, input),
      verify: (context) => verifyFillerSkill(context),
    },
  };
}

async function planFillerSkill(context: SkillPlanningContext, input: Record<string, unknown>) {
  const selectedRange = input.range as TimeRange;
  const selectedCandidateIds = new Set((input.selectedCandidateIds as string[] | undefined) ?? []);
  const detector = new FillerDetector({
    ...(input.confidenceThreshold !== undefined ? { confidenceThreshold: input.confidenceThreshold as number } : {}),
  });
  const resolver = new SafeCutResolver({
    ...(input.preservePauseMs !== undefined ? { preservePauseMs: input.preservePauseMs as number } : {}),
    ...(input.targetPauseMs !== undefined ? { targetPauseMs: input.targetPauseMs as number } : {}),
  });
  if (!context.analyzeSpeech) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
  const candidates: FillerCandidate[] = [];
  const decisions: SafeCutDecision[] = [];
  const operations: Array<Extract<import("../domain/editing.js").WorkflowOperation, { type: "ripple-delete" }>> = [];
  for (const clip of context.project.timeline.clips.filter((candidate) =>
    Boolean(candidate.mediaId)
      && candidate.start < selectedRange.end
      && candidate.start + candidate.duration > selectedRange.start,
  )) {
    const mediaId = clip.mediaId!;
    const localRange = {
      start: Math.max(0, selectedRange.start - clip.start),
      end: Math.min(clip.duration, selectedRange.end - clip.start),
    };
    if (localRange.end <= localRange.start) continue;
    const sourceStart = clip.sourceStart ?? 0;
    const sourceRange = {
      start: sourceStart + localRange.start,
      end: sourceStart + localRange.end,
    };
    const speech = await context.analyzeSpeech(mediaId, sourceRange);
    const occurrence = {
      occurrenceId: clip.id,
      mediaId,
      sourceRange,
      sequenceRange: { start: clip.start + localRange.start, end: clip.start + localRange.end },
    };
    const detected = detector.detect({
      previewId: `filler-removal:${context.baseRevision.id}:${clip.id}:${selectedRange.start}:${selectedRange.end}`,
      revisionId: context.baseRevision.id,
      analysis: speech,
      targetRange: selectedRange,
      occurrence,
    });
    for (const candidate of detected) {
      const decision = resolver.resolve({
        candidate,
        analysis: speech,
        targetRange: selectedRange,
        occurrence,
        timelineId: context.project.timeline.id,
        sequenceFrameDuration: { value: "1", timescale: "30" },
      });
      candidates.push(candidate);
      decisions.push(decision);
      if (decision.operation && (decision.status === "AUTO_APPLY"
        || decision.status === "SUGGESTED" && selectedCandidateIds.has(decision.candidateId))) {
        operations.push({ ...decision.operation, candidateId: decision.candidateId });
      }
    }
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const selectedCandidateId of selectedCandidateIds) {
    if (!candidateIds.has(selectedCandidateId)) {
      throw new Error(`CANDIDATE_NOT_FOUND: filler candidate ${selectedCandidateId} is not in the selected revision-bound range`);
    }
  }
  const warnings = decisions.flatMap((decision) => decision.status === "AUTO_APPLY"
    ? []
    : [`${decision.candidateId}: ${decision.status.toLowerCase()} (${decision.reasonCodes.join(", ")})`]);
  return {
    operations: operations.sort((left, right) => right.range.start - left.range.start),
    affectedRanges: operations.map((operation) => structuredClone(operation.range)),
    warnings,
    verification: { requireExpectedChange: true, requireSpeechContinuity: true },
    details: {
      range: structuredClone(selectedRange),
      candidates: structuredClone(candidates),
      decisions: structuredClone(decisions),
      selectedCandidateIds: [...selectedCandidateIds],
      candidateProvenance: operations.map((operation, operationIndex) => ({
        candidateId: operation.candidateId!,
        occurrenceId: decisions.find((decision) => decision.candidateId === operation.candidateId)?.occurrenceId,
        operationIndex,
        operationRange: structuredClone(operation.range),
        sourceDeleteRange: sourceDeleteRangeFor(operation, candidates),
        diffRanges: [structuredClone(operation.range)],
      })),
    },
  };
}

interface FillerSkillDetails {
  candidates: FillerCandidate[];
  decisions: SafeCutDecision[];
  candidateProvenance: Array<{
    candidateId: string;
    occurrenceId?: string;
    operationIndex: number;
    operationRange: TimeRange;
    sourceDeleteRange: TimeRange;
    diffRanges: TimeRange[];
  }>;
}

function verifyFillerSkill(context: SkillVerificationContext): import("../domain/verification.js").VerificationCheck[] {
  const details = context.plan.details as Partial<FillerSkillDetails> | undefined;
  const transaction = context.transaction;
  const checks = [
    verifyFillerTargetsAbsent(transaction, details),
    verifyProtectedSpeech(transaction),
    verifySpeechContinuity(transaction, details),
    verifyAuthorizedDiff(transaction, context.expectedDiff),
    verifyPlannedDuration(transaction, details),
  ];
  return checks;
}

function verifyFillerTargetsAbsent(
  transaction: EditTransaction,
  details: Partial<FillerSkillDetails> | undefined,
): import("../domain/verification.js").VerificationCheck {
  const candidates = details?.candidates ?? [];
  const appliedIds = new Set((details?.candidateProvenance ?? []).map((item) => item.candidateId));
  const applied = candidates.filter((candidate) => appliedIds.has(candidate.id));
  const remaining = applied.filter((candidate) => transaction.attemptedAfter.media.some((media) =>
    media.speech?.words.some((word) => word.filler === true && word.text.trim().toLowerCase() === candidate.word.text.trim().toLowerCase()),
  ));
  return {
    name: "filler-targets-absent",
    passed: remaining.length === 0,
    detail: remaining.length === 0
      ? "re-analysis contains no applied filler candidates"
      : `re-analysis still contains ${remaining.length} applied filler candidate(s)`,
    ...(remaining.length > 0 ? { reason: "FILLER_REMAINS_AFTER_REANALYSIS" } : {}),
    expected: applied.map((candidate) => candidate.id),
    observed: remaining.map((candidate) => candidate.id),
  };
}

function verifySpeechContinuity(
  transaction: EditTransaction,
  details: Partial<FillerSkillDetails> | undefined,
): import("../domain/verification.js").VerificationCheck {
  const provenance = details?.candidateProvenance ?? [];
  if (provenance.length === 0) {
    return {
      name: "filler-speech-continuity",
      passed: false,
      detail: "filler candidate provenance is unavailable for continuity verification",
      reason: "SPEECH_CONTINUITY_UNAVAILABLE",
    };
  }
  const candidateById = new Map((details?.candidates ?? []).map((candidate) => [candidate.id, candidate]));
  const byOccurrence = new Map<string, typeof provenance>();
  for (const item of provenance) {
    const occurrence = item.occurrenceId;
    if (!occurrence) return {
      name: "filler-speech-continuity",
      passed: false,
      detail: `candidate ${item.candidateId} has no timeline occurrence provenance`,
      reason: "SPEECH_CONTINUITY_UNAVAILABLE",
    };
    const items = byOccurrence.get(occurrence) ?? [];
    items.push(item);
    byOccurrence.set(occurrence, items);
  }

  for (const [occurrenceId, items] of byOccurrence) {
    const beforeClip = transaction.before.timeline.clips.find((clip) => clip.id === occurrenceId);
    const afterClip = transaction.attemptedAfter.timeline.clips.find((clip) => clip.id === occurrenceId);
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
        detail: `complete pre- and post-edit speech analysis is unavailable for filler target clip ${occurrenceId}`,
        reason: "SPEECH_CONTINUITY_UNAVAILABLE",
      };
    }
    const candidateIds = new Set(items.map((item) => item.candidateId));
    const deletes = items
      .map((item) => item.sourceDeleteRange)
      .sort((left, right) => left.start - right.start);
    const expectedWords = beforeWords
      .filter((word) => ![...candidateIds].some((candidateId) => {
        const candidate = candidateById.get(candidateId);
        return candidate ? sameSpeechWord(candidate.word, word) : false;
      }))
      .map((word) => translateSpeechWordAfterDeletes(word, deletes));
    if (expectedWords.length !== actualWords.length) {
      return {
        name: "filler-speech-continuity",
        passed: false,
        detail: `post-edit transcript has ${actualWords.length} words; expected ${expectedWords.length} adjacent words after filler removal`,
        reason: "SPEECH_CONTINUITY_CHANGED",
      };
    }
    for (let index = 0; index < expectedWords.length; index += 1) {
      const expected = expectedWords[index]!;
      const actual = actualWords[index]!;
      if (!sameSpeechWord(expected, actual)
        || actual.end > (afterClip.sourceStart ?? 0) + afterClip.duration + 0.02) {
        return {
          name: "filler-speech-continuity",
          passed: false,
          detail: `post-edit transcript boundary ${index + 1} does not preserve adjacent speech around the removed fillers`,
          reason: "SPEECH_CONTINUITY_CHANGED",
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

function sourceDeleteRangeFor(
  operation: Extract<import("../domain/editing.js").WorkflowOperation, { type: "ripple-delete" }>,
  candidates: FillerCandidate[],
): TimeRange {
  const candidate = candidates.find((item) => item.id === operation.candidateId);
  if (!candidate) return structuredClone(operation.range);
  return {
    start: candidate.sourceRange.start + operation.range.start - candidate.sequenceRange.start,
    end: candidate.sourceRange.start + operation.range.end - candidate.sequenceRange.start,
  };
}

function translateSpeechWordAfterDeletes(word: SpeechWord, deletes: TimeRange[]): SpeechWord {
  return {
    ...word,
    start: translateBoundaryAfterDeletes(word.start, deletes),
    end: translateBoundaryAfterDeletes(word.end, deletes),
  };
}

function translateBoundaryAfterDeletes(boundary: number, deletes: TimeRange[]): number {
  let translated = boundary;
  let removed = 0;
  for (const deletion of deletes) {
    if (boundary <= deletion.start) break;
    if (boundary < deletion.end) return deletion.start - removed;
    translated -= deletion.end - deletion.start;
    removed += deletion.end - deletion.start;
  }
  return translated;
}

function sameSpeechWord(left: SpeechWord, right: SpeechWord): boolean {
  return left.text.trim().toLowerCase() === right.text.trim().toLowerCase()
    && Math.abs(left.start - right.start) <= 0.02
    && Math.abs(left.end - right.end) <= 0.02;
}

function verifyProtectedSpeech(transaction: EditTransaction): import("../domain/verification.js").VerificationCheck {
  const beforeProtected = transaction.before.media.flatMap((media) => media.speech?.protectedSegments ?? []);
  const afterProtected = transaction.attemptedAfter.media.flatMap((media) => media.speech?.protectedSegments ?? []);
  const passed = beforeProtected.length === afterProtected.length
    && beforeProtected.every((segment, index) => sameSegment(segment, afterProtected[index]));
  return {
    name: "protected-speech-intact",
    passed,
    detail: passed ? "protected speech evidence is unchanged" : "protected speech evidence changed after filler removal",
    ...(passed ? {} : { reason: "PROTECTED_SPEECH_CHANGED" }),
  };
}

function verifyAuthorizedDiff(transaction: EditTransaction, expectedDiff?: TimelineDiff): import("../domain/verification.js").VerificationCheck {
  if (!expectedDiff) {
    return {
      name: "authorized-canonical-diff",
      passed: false,
      status: "unavailable",
      detail: "the editor did not provide an expected canonical diff",
      reason: "EXPECTED_DIFF_UNAVAILABLE",
    };
  }
  const actual = diffSignature(transaction.diff);
  const expected = diffSignature(expectedDiff);
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  return {
    name: "authorized-canonical-diff",
    passed,
    detail: passed ? "canonical diff matches the authorized preview" : "canonical diff contains unauthorized changes",
    ...(passed ? {} : { reason: "UNEXPECTED_DIFF", expected, observed: actual }),
  };
}

function verifyPlannedDuration(
  transaction: EditTransaction,
  details: Partial<FillerSkillDetails> | undefined,
): import("../domain/verification.js").VerificationCheck {
  const expected = (details?.candidateProvenance ?? []).reduce((total, item) => total + (item.operationRange.end - item.operationRange.start), 0);
  const observed = Math.abs(transaction.diff.durationDelta);
  const passed = Math.abs(observed - expected) <= 0.000001;
  return {
    name: "planned-duration-change",
    passed,
    detail: passed ? "timeline duration changed by the authorized deleted frames" : "timeline duration differs from the authorized delete duration",
    ...(passed ? {} : { reason: "DURATION_DELTA_MISMATCH", expected: -expected, observed: transaction.diff.durationDelta }),
  };
}

function diffSignature(diff: TimelineDiff): unknown {
  return {
    added: diff.added.map((item) => item.after?.id ?? item.itemId),
    removed: diff.removed.map((item) => item.before?.id ?? item.itemId),
    modified: diff.modified.map((item) => item.after?.id ?? item.itemId),
    markerChanges: diff.markerChanges.map((item) => item.marker.id),
    captionChanges: diff.captionChanges.map((item) => item.caption.id),
    storyElementChanges: diff.storyElementChanges.map((item) => item.element.id),
    mediaChanges: diff.mediaChanges.map((item) => item.media.mediaId),
    durationDelta: diff.durationDelta,
    affectedRanges: diff.affectedRanges,
  };
}

function sameSegment(left: { start: number; end: number; kind: string }, right: { start: number; end: number; kind: string } | undefined): boolean {
  if (!right) return false;
  return left.kind === right.kind
    && Math.abs(left.start - right.start) <= 0.000001
    && Math.abs(left.end - right.end) <= 0.000001;
}

function dialogueNormalizationSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "dialogue-normalization",
      version: "1.0.0",
      title: "Dialogue normalization",
      description: "Normalize one complete dialogue clip occurrence with measured loudness and peak verification.",
      defaults: { ...DIALOGUE_NORMALIZATION_DEFAULTS },
      inputSchema: {
        type: "object",
        properties: {
          mediaId: { type: "string", minLength: 1 },
          occurrenceId: { type: "string", minLength: 1 },
          targetLufs: { type: "number" },
          toleranceDb: { type: "number", minimum: 0 },
          maxTruePeakDb: { type: "number" },
          minGainDb: { type: "number" },
          maxGainDb: { type: "number" },
          minDialogueDurationSeconds: { type: "number", minimum: 0 },
        },
        required: ["mediaId", "occurrenceId"],
        additionalProperties: false,
      },
      requirements: {
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          {
            type: "anyOf",
            requirements: [
              { type: "editor", capability: "timelineWrite" },
              { type: "editor", capability: "timelineArtifactWrite" },
            ],
          },
          { type: "editor", capability: "readAfterWrite" },
          { type: "editor", capability: "rollback" },
          { type: "editor", capability: "compositeTransactions" },
          { type: "analyzer", capability: "audioLoudness" },
          { type: "operation", operation: "set-gain" },
        ],
      },
    },
    handler: {
      normalize: (input) => ({ ...DIALOGUE_NORMALIZATION_DEFAULTS, ...(input as Record<string, unknown>) }),
      plan: async (context, input) => planDialogueSkill(context, input),
    },
  };
}

function noiseReductionSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "audio-noise-reduction",
      version: "1.0.0",
      title: "Audio noise reduction",
      description: "Detect unwanted background noise and apply a bounded, verified reduction to one audio occurrence.",
      inputSchema: {
        type: "object",
        properties: {
          mediaId: { type: "string", minLength: 1 },
          occurrenceId: { type: "string", minLength: 1 },
          noiseThresholdDb: { type: "number" },
          maxReductionDb: { type: "number", minimum: 0 },
          minConfidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["mediaId", "occurrenceId", "noiseThresholdDb", "maxReductionDb", "minConfidence"],
        additionalProperties: false,
      },
      requirements: {
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          { type: "editor", capability: "timelineWrite" },
          { type: "editor", capability: "readAfterWrite" },
          { type: "editor", capability: "rollback" },
          { type: "editor", capability: "compositeTransactions" },
          { type: "editor", capability: "noiseReduction" },
          { type: "analyzer", capability: "audioNoise" },
          { type: "operation", operation: "reduce-noise" },
        ],
      },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: async (context, input) => planNoiseSkill(context, input),
    },
  };
}

async function planNoiseSkill(context: SkillPlanningContext, input: Record<string, unknown>) {
  if (!context.measureNoise) throw new Error("CAPABILITY_UNAVAILABLE: audio noise analysis");
  const clip = context.project.timeline.clips.find((candidate) => candidate.id === input.occurrenceId);
  if (!clip) throw new Error(`OCCURRENCE_NOT_FOUND: ${String(input.occurrenceId)}`);
  if (clip.mediaId !== input.mediaId) {
    throw new Error(`TARGET_MISMATCH: occurrence ${String(input.occurrenceId)} does not reference media ${String(input.mediaId)}`);
  }
  const request = input as unknown as NoiseReductionRequest;
  const measurement = await context.measureNoise(request.mediaId, request.occurrenceId);
  const plan = planNoiseReduction(measurement, request);
  const timelineRanges = plan.decision === "APPLY"
    ? plan.affectedRanges.map((range) => ({
      start: clip.start + range.start,
      end: clip.start + range.end,
    }))
    : [];
  const verification = plan.decision === "APPLY" ? {
    requireExpectedChange: true,
    assertions: [{
      type: "audio-noise" as const,
      mediaId: request.mediaId,
      maxNoiseFloorDb: request.noiseThresholdDb,
      minConfidence: request.minConfidence,
    }],
  } : undefined;
  return {
    operations: plan.decision === "APPLY" ? timelineRanges.map((range) => ({
      type: "reduce-noise" as const,
      clipId: clip.id,
      range,
      reductionDb: plan.reductionDb,
      baseRevision: context.baseRevision,
    })) : [],
    affectedRanges: structuredClone(timelineRanges),
    warnings: plan.decision === "SKIP" ? [...plan.reasonCodes] : [],
    ...(verification ? { verification } : {}),
    details: {
      measurement: structuredClone(measurement),
      plan: structuredClone(plan),
      timelineAffectedRanges: structuredClone(timelineRanges),
    },
  };
}

function colorCorrectionSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "color-correction",
      version: "1.0.0",
      title: "Basic color correction",
      description: "Apply a clip-scoped basic color correction with before/after verification.",
      inputSchema: {
        type: "object",
        properties: {
          clipId: { type: "string", minLength: 1 },
          preset: { type: "string", enum: ["neutral", "warm", "cool", "high-contrast"] },
          exposure: { type: "number", minimum: -4, maximum: 4 },
          contrast: { type: "number", minimum: -1, maximum: 1 },
          saturation: { type: "number", minimum: -1, maximum: 1 },
          temperature: { type: "number", minimum: -100, maximum: 100 },
          tint: { type: "number", minimum: -100, maximum: 100 },
        },
        required: ["clipId"],
        additionalProperties: false,
      },
      requirements: {
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          { type: "editor", capability: "timelineWrite" },
          { type: "editor", capability: "readAfterWrite" },
          { type: "editor", capability: "rollback" },
          { type: "editor", capability: "compositeTransactions" },
          { type: "editor", capability: "colorCorrection" },
          { type: "operation", operation: "set-color-correction" },
        ],
      },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: async (context, input) => planColorSkill(context, input),
    },
  };
}

async function planColorSkill(context: SkillPlanningContext, input: Record<string, unknown>) {
  const clip = context.project.timeline.clips.find((candidate) => candidate.id === input.clipId);
  if (!clip) throw new Error(`CLIP_NOT_FOUND: ${String(input.clipId)}`);
  const request = input as unknown as ColorCorrectionRequest;
  const plan = planColorCorrection(clip, request);
  const affectedRange = { start: clip.start, end: clip.start + clip.duration };
  const verification = plan.decision === "APPLY" ? {
    requireExpectedChange: true,
    assertions: [{
      type: "color-correction" as const,
      clipId: clip.id,
      expected: structuredClone(plan.after),
    }],
  } : undefined;
  return {
    operations: plan.decision === "APPLY" ? [{
      type: "set-color-correction" as const,
      clipId: clip.id,
      correction: structuredClone(plan.after),
      baseRevision: context.baseRevision,
    }] : [],
    affectedRanges: plan.decision === "APPLY" ? [affectedRange] : [],
    warnings: [],
    ...(verification ? { verification } : {}),
    details: {
      before: structuredClone(plan.before),
      after: structuredClone(plan.after),
      changedFields: [...plan.changedFields],
      reasonCodes: [...plan.reasonCodes],
    },
  };
}

async function planDialogueSkill(context: SkillPlanningContext, input: Record<string, unknown>) {
  if (!context.measureAudio) throw new Error("CAPABILITY_UNAVAILABLE: audio analysis");
  const request = input as unknown as DialogueNormalizationRequest;
  const clip = context.project.timeline.clips.find((candidate) => candidate.id === request.occurrenceId);
  if (!clip) throw new Error(`OCCURRENCE_NOT_FOUND: ${request.occurrenceId}`);
  if (clip.mediaId !== request.mediaId) {
    throw new Error(`TARGET_MISMATCH: occurrence ${request.occurrenceId} does not reference media ${request.mediaId}`);
  }
  const existingGainDb = clip.gainDb ?? 0;
  if (!Number.isFinite(existingGainDb)) throw new Error(`INVALID_OPERATION: occurrence ${request.occurrenceId} has an invalid gain`);
  const measurement = await context.measureAudio(request.mediaId, request.occurrenceId);
  const plan = planDialogueGain(measurement, request);
  const targetGainDb = Number((existingGainDb + plan.clampedGainDb).toFixed(6));
  const verification = plan.decision === "APPLY" ? {
    requireExpectedChange: true,
    maxTruePeakDb: request.maxTruePeakDb,
    assertions: [{
      type: "audio-loudness" as const,
      mediaId: request.mediaId,
      occurrenceId: request.occurrenceId,
      targetLufs: request.targetLufs,
      toleranceDb: request.toleranceDb,
    }],
  } : undefined;
  return {
    operations: plan.decision === "APPLY" ? [{
      type: "set-gain" as const,
      clipId: request.occurrenceId,
      gainDb: targetGainDb,
      baseRevision: context.baseRevision,
    }] : [],
    decision: plan.decision,
    affectedRanges: plan.decision === "APPLY" ? [{
      start: clip.start,
      end: clip.start + clip.duration,
    }] : [],
    warnings: plan.decision === "SKIP" ? [...plan.reasonCodes] : [],
    ...(verification ? { verification } : {}),
    details: {
      occurrenceId: request.occurrenceId,
      mediaId: request.mediaId,
      existingGainDb,
      targetGainDb,
      measurement: structuredClone(measurement),
      truePeakDb: measurement.truePeakDb,
      ...structuredClone(plan),
    },
  };
}
