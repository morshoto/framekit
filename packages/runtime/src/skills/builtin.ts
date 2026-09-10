import type { SkillDefinition, SkillPlanningContext } from "../domain/skills.js";
import type { TimeRange } from "../domain/primitives.js";
import { planFillerRemoval } from "../speech/filler-removal.js";
import { translateRationalRange } from "../timeline/rational-time.js";
import { planDialogueGain, type DialogueNormalizationRequest } from "../audio/dialogue-normalization.js";
import { planNoiseReduction, type NoiseReductionRequest } from "../audio/noise-reduction.js";
import { planColorCorrection, type ColorCorrectionRequest } from "../color-correction.js";
import type { FillerRemovalTarget } from "../speech/filler-removal.js";

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
          { type: "analyzer", capability: "speechTranscribe" },
          { type: "operation", operation: "ripple-delete" },
        ],
      },
      verification: { requireExpectedChange: true, requireSpeechContinuity: true },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: async (context, input) => planFillerSkill(context, input),
    },
  };
}

async function planFillerSkill(context: SkillPlanningContext, input: Record<string, unknown>) {
  const selectedRange = input.range as TimeRange;
  const options = {
    ...(input.confidenceThreshold !== undefined ? { confidenceThreshold: input.confidenceThreshold as number } : {}),
    ...(input.preservePauseMs !== undefined ? { preservePauseMs: input.preservePauseMs as number } : {}),
    ...(input.targetPauseMs !== undefined ? { targetPauseMs: input.targetPauseMs as number } : {}),
  };
  if (!context.analyzeSpeech) throw new Error("CAPABILITY_UNAVAILABLE: speech analysis");
  const candidates: FillerRemovalTarget[] = [];
  const selectedMediaIds = new Set<string>();
  for (const clip of context.project.timeline.clips.filter((candidate) =>
    Boolean(candidate.mediaId)
      && candidate.start < selectedRange.end
      && candidate.start + candidate.duration > selectedRange.start,
  )) {
    const mediaId = clip.mediaId!;
    if (selectedMediaIds.has(mediaId)) {
      throw new Error("CAPABILITY_UNAVAILABLE: filler removal cannot verify repeated timeline occurrences of the same media item");
    }
    selectedMediaIds.add(mediaId);
    const localRange = {
      start: Math.max(0, selectedRange.start - clip.start),
      end: Math.min(clip.duration, selectedRange.end - clip.start),
    };
    if (localRange.end <= localRange.start) continue;
    const speech = await context.analyzeSpeech(mediaId, localRange);
    const mediaCandidates = planFillerRemoval(speech.words, localRange, options);
    for (const candidate of mediaCandidates) {
      candidates.push({
        ...candidate,
        clipId: clip.id,
        mediaId,
        sourceRange: structuredClone(candidate.range),
        range: translateRationalRange(clip.startTime, clip.start, candidate.range),
      });
    }
  }
  if (candidates.length === 0) throw new Error("NO_FILLERS_FOUND: no high-confidence filler words in selected range");
  candidates.sort((left, right) => right.range.start - left.range.start);
  return {
    operations: candidates.map((candidate) => ({
      type: "ripple-delete" as const,
      timelineId: context.project.timeline.id,
      range: structuredClone(candidate.range),
      reason: `remove high-confidence filler word: ${candidate.word.text}`,
    })),
    affectedRanges: candidates.map((candidate) => structuredClone(candidate.range)),
    warnings: [],
    details: { range: structuredClone(selectedRange), candidates: structuredClone(candidates) },
  };
}

function dialogueNormalizationSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "dialogue-normalization",
      version: "1.0.0",
      title: "Dialogue normalization",
      description: "Normalize one complete dialogue clip occurrence with measured loudness and peak verification.",
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
        required: ["mediaId", "occurrenceId", "targetLufs", "toleranceDb", "maxTruePeakDb", "minGainDb", "maxGainDb", "minDialogueDurationSeconds"],
        additionalProperties: false,
      },
      requirements: {
        type: "allOf",
        requirements: [
          { type: "editor", capability: "timelineSnapshotRead" },
          { type: "editor", capability: "timelineWrite" },
          { type: "editor", capability: "readAfterWrite" },
          { type: "editor", capability: "rollback" },
          { type: "analyzer", capability: "audioLoudness" },
          { type: "operation", operation: "set-gain" },
        ],
      },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
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
  const measurement = await context.measureAudio(request.mediaId, request.occurrenceId);
  const plan = planDialogueGain(measurement, request);
  const verification = plan.decision === "APPLY" ? {
    requireExpectedChange: true,
    maxTruePeakDb: request.maxTruePeakDb,
    assertions: [{
      type: "audio-loudness" as const,
      mediaId: request.mediaId,
      targetLufs: request.targetLufs,
      toleranceDb: request.toleranceDb,
    }],
  } : undefined;
  return {
    operations: plan.decision === "APPLY" ? [{
      type: "set-gain" as const,
      clipId: request.occurrenceId,
      gainDb: plan.clampedGainDb,
      baseRevision: context.baseRevision,
    }] : [],
    affectedRanges: plan.decision === "APPLY" ? [{
      start: context.project.timeline.clips.find((clip) => clip.id === request.occurrenceId)?.start ?? 0,
      end: (context.project.timeline.clips.find((clip) => clip.id === request.occurrenceId)?.start ?? 0)
        + (context.project.timeline.clips.find((clip) => clip.id === request.occurrenceId)?.duration ?? 0),
    }] : [],
    warnings: plan.decision === "SKIP" ? [...plan.reasonCodes] : [],
    ...(verification ? { verification } : {}),
    details: { measurement: structuredClone(measurement), ...structuredClone(plan) },
  };
}
