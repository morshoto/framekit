import type { EditTransaction, WorkflowOperation } from "../domain/editing.js";
import type {
  AudioAudibilityAssertion,
  AudioCoverageAssertion,
  AudioLoudnessAssertion,
  AudioSourceAssertion,
  DurationAssertion,
  StreamAssertion,
  StructureAssertion,
  VerificationCheck,
  VerificationEngine,
  VerificationPolicy,
  VerificationReport,
  VerificationAssertion,
  VisualContentAssertion,
} from "../domain/verification.js";

export class DefaultVerificationEngine implements VerificationEngine {
  public async verify(transaction: EditTransaction, policy: VerificationPolicy): Promise<VerificationReport> {
    const checks: VerificationCheck[] = [
      {
        name: "timeline-valid",
        passed: transaction.after.timeline.clips.every((clip) => clip.duration >= 0)
          && transaction.after.timeline.clips.every((clip) => !clip.mediaId
            || transaction.after.media.some((media) => media.mediaId === clip.mediaId)),
        detail: "clip durations are valid and media references resolve",
      },
      {
        name: "audio-state",
        passed: audioStateIsValid(transaction),
        detail: audioStateDetail(transaction),
      },
      {
        name: "read-after-write",
        passed: transaction.attemptedAfter.revision.sequence > transaction.before.revision.sequence,
        detail: "the editor returned a newer revision after the write",
      },
    ];

    if (policy.requireExpectedChange !== false) {
      checks.push({
        name: "expected-change",
        passed: transaction.diff.added.length + transaction.diff.removed.length + transaction.diff.modified.length
          + transaction.diff.markerChanges.length + transaction.diff.captionChanges.length
          + transaction.diff.storyElementChanges.length + transaction.diff.mediaChanges.length > 0,
        detail: "the canonical diff contains the requested project change",
      });
    }

    if (policy.maxTruePeakDb !== undefined) {
      const peaks = transaction.attemptedAfter.media
        .map((media) => media.audio?.truePeakDb)
        .filter((peak): peak is number => peak !== undefined);
      const passed = peaks.length > 0 && peaks.every((peak) => peak <= policy.maxTruePeakDb!);
      checks.push({
        name: "true-peak-limit",
        passed,
        detail: passed
          ? `all measured peaks are at or below ${policy.maxTruePeakDb} dB`
          : `a measured peak exceeds ${policy.maxTruePeakDb} dB`,
      });
    }

    if (policy.targetLufs !== undefined) {
      const tolerance = policy.loudnessToleranceDb ?? 0.5;
      const loudness = transaction.attemptedAfter.media
        .map((media) => media.audio?.integratedLufs)
        .filter((value): value is number => value !== undefined);
      const passed = loudness.length > 0 && loudness.every((value) => Math.abs(value - policy.targetLufs!) <= tolerance);
      checks.push({
        name: "integrated-loudness-target",
        passed,
        detail: passed
          ? `all measured loudness values are within ${tolerance} dB of ${policy.targetLufs} LUFS`
          : `a measured loudness value is outside ${tolerance} dB of ${policy.targetLufs} LUFS`,
      });
    }

    if (policy.requireSpeechContinuity) {
      const beforeSpeechClips = transaction.before.timeline.clips.filter((clip) => {
        const media = transaction.before.media.find((candidate) => candidate.mediaId === clip.mediaId);
        return Boolean(media?.speech);
      });
      const continuity = beforeSpeechClips.every((beforeClip) => {
        const afterClip = transaction.attemptedAfter.timeline.clips.find((clip) => clip.id === beforeClip.id);
        if (!afterClip) return false;
        const media = transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === afterClip.mediaId);
        return !media?.speech || media.speech.words.every((word) => word.end <= afterClip.duration);
      });
      checks.push({
        name: "speech-continuity",
        passed: continuity,
        detail: continuity ? "speech words remain inside their clip bounds" : "a speech word would be clipped",
      });
    }

    checks.push(...(policy.assertions ?? []).map((assertion) => verifyAssertion(transaction, assertion)));

    return { passed: checks.every((check) => check.passed), checks };
  }
}

function verifyAssertion(transaction: EditTransaction, assertion: VerificationAssertion): VerificationCheck {
  if (assertion.type === "audio-coverage") return verifyAudioCoverage(transaction, assertion);
  if (assertion.type === "audio-loudness") return verifyAudioLoudness(transaction, assertion);
  if (assertion.type === "audio-source") return verifyAudioSource(transaction, assertion);
  if (assertion.type === "visual-content") return verifyVisualContent(transaction, assertion);
  if (assertion.type === "duration") return verifyDuration(transaction, assertion);
  if (assertion.type === "stream") return verifyStream(transaction, assertion);
  if (assertion.type === "structure") return verifyStructure(transaction, assertion);
  return verifyAudioAudibility(transaction, assertion);
}

function verifyAudioAudibility(transaction: EditTransaction, assertion: AudioAudibilityAssertion): VerificationCheck {
  const expected = {
    mediaId: assertion.mediaId,
    minAudibleSamples: assertion.minAudibleSamples ?? 1,
    ...(assertion.maxSilenceMs !== undefined ? { maxSilenceMs: assertion.maxSilenceMs } : {}),
  };
  const media = transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === assertion.mediaId);
  if (!media) {
    return {
      name: assertion.type,
      passed: false,
      status: "failed",
      expected,
      observed: { mediaId: assertion.mediaId },
      reason: "MEDIA_NOT_FOUND",
      detail: `expected audio media ${assertion.mediaId}, but it was not observed`,
    };
  }
  if (!media.audio) {
    return {
      name: assertion.type,
      passed: false,
      status: "unavailable",
      expected,
      observed: { mediaId: assertion.mediaId },
      reason: "AUDIO_ANALYZER_UNAVAILABLE",
      detail: `audio analysis is unavailable for media ${assertion.mediaId}`,
    };
  }
  const observed = {
    mediaId: assertion.mediaId,
    ...(media.audio.audibleSamples !== undefined ? { audibleSamples: media.audio.audibleSamples } : {}),
    silenceMs: media.audio.silenceMs,
  };
  const minAudibleSamples = assertion.minAudibleSamples ?? 1;
  const audible = media.audio.audibleSamples === undefined
    ? media.audio.silenceMs < (media.duration ?? Number.POSITIVE_INFINITY) * 1000
    : media.audio.audibleSamples >= minAudibleSamples;
  const silenceWithinLimit = assertion.maxSilenceMs === undefined || media.audio.silenceMs <= assertion.maxSilenceMs;
  const passed = audible && silenceWithinLimit;
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    ...(passed ? {} : { reason: audible ? "AUDIO_SILENCE_EXCEEDED" : "AUDIO_NOT_AUDIBLE" }),
    detail: passed
      ? `observed audible audio for media ${assertion.mediaId}`
      : audible
        ? `expected silence at or below ${assertion.maxSilenceMs}ms, observed ${media.audio.silenceMs}ms`
        : "expected audible audio samples, observed none",
  };
}

function verifyAudioCoverage(transaction: EditTransaction, assertion: AudioCoverageAssertion): VerificationCheck {
  const toleranceSeconds = assertion.toleranceSeconds ?? 0;
  const expected = {
    mediaId: assertion.mediaId,
    start: assertion.start,
    duration: assertion.duration,
    toleranceSeconds,
  };
  const intervals = transaction.attemptedAfter.timeline.clips
    .filter((clip) => clip.mediaId === assertion.mediaId)
    .map((clip) => ({
      start: Math.max(assertion.start, clip.start),
      end: Math.min(assertion.start + assertion.duration, clip.start + clip.duration),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = ranges[ranges.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else ranges.push({ ...interval });
  }
  const observed = {
    mediaId: assertion.mediaId,
    ranges,
    start: ranges[0]?.start ?? null,
    end: ranges.at(-1)?.end ?? null,
    duration: ranges.reduce((total, range) => total + range.end - range.start, 0),
  };
  const passed = ranges.length === 1
    && observed.start !== null
    && observed.start <= assertion.start + toleranceSeconds
    && observed.end !== null
    && observed.end >= assertion.start + assertion.duration - toleranceSeconds;
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    ...(passed ? {} : { reason: "AUDIO_COVERAGE_INCOMPLETE" }),
    detail: passed
      ? `observed continuous audio coverage for media ${assertion.mediaId}`
      : `expected ${assertion.duration}s of continuous audio coverage, observed ${observed.duration}s`,
  };
}

function verifyAudioLoudness(transaction: EditTransaction, assertion: AudioLoudnessAssertion): VerificationCheck {
  const toleranceDb = assertion.toleranceDb ?? 0.5;
  const expected = {
    mediaId: assertion.mediaId,
    targetLufs: assertion.targetLufs,
    toleranceDb,
  };
  const media = transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === assertion.mediaId);
  if (!media?.audio) {
    return {
      name: assertion.type,
      passed: false,
      status: "unavailable",
      expected,
      observed: { mediaId: assertion.mediaId },
      reason: "AUDIO_ANALYZER_UNAVAILABLE",
      detail: `audio analysis is unavailable for media ${assertion.mediaId}`,
    };
  }
  const observed = media.audio.integratedLufs;
  const passed = Math.abs(observed - assertion.targetLufs) <= toleranceDb;
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    ...(passed ? {} : { reason: "AUDIO_LOUDNESS_OUT_OF_RANGE" }),
    detail: passed
      ? `observed ${observed} LUFS within ${toleranceDb} dB of ${assertion.targetLufs} LUFS`
      : `expected ${assertion.targetLufs} LUFS ±${toleranceDb} dB, observed ${observed} LUFS`,
  };
}

function verifyAudioSource(transaction: EditTransaction, assertion: AudioSourceAssertion): VerificationCheck {
  const expected = {
    mediaId: assertion.mediaId,
    ...(assertion.sourceDigest !== undefined ? { sourceDigest: assertion.sourceDigest } : {}),
    ...(assertion.source !== undefined ? { source: assertion.source } : {}),
  };
  const media = transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === assertion.mediaId);
  const observed = media
    ? {
      mediaId: assertion.mediaId,
      ...(media.sourceDigest !== undefined ? { sourceDigest: media.sourceDigest } : {}),
      source: media.source,
    }
    : { mediaId: assertion.mediaId };
  if (!media) {
    return {
      name: assertion.type,
      passed: false,
      status: "failed",
      expected,
      observed,
      reason: "MEDIA_NOT_FOUND",
      detail: `expected source media ${assertion.mediaId}, but it was not observed`,
    };
  }
  const passed = (assertion.sourceDigest === undefined || media.sourceDigest === assertion.sourceDigest)
    && (assertion.source === undefined || media.source === assertion.source)
    && (assertion.sourceDigest !== undefined || assertion.source !== undefined);
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    ...(passed ? {} : { reason: "AUDIO_SOURCE_MISMATCH" }),
    detail: passed
      ? `observed the expected source identity for media ${assertion.mediaId}`
      : `expected source identity for media ${assertion.mediaId}, but the observed identity differed`,
  };
}

function verifyVisualContent(transaction: EditTransaction, assertion: VisualContentAssertion): VerificationCheck {
  const labelKind = assertion.labelKind ?? "subject";
  const expected = {
    mediaId: assertion.mediaId,
    label: assertion.label,
    labelKind,
    ...(assertion.minConfidence !== undefined ? { minConfidence: assertion.minConfidence } : {}),
  };
  const media = transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === assertion.mediaId);
  if (!media) {
    return {
      name: assertion.type,
      passed: false,
      status: "failed",
      expected,
      observed: { mediaId: assertion.mediaId },
      reason: "MEDIA_NOT_FOUND",
      detail: `expected visual media ${assertion.mediaId}, but it was not observed`,
    };
  }
  if (!media.visual) {
    return {
      name: assertion.type,
      passed: false,
      status: "unavailable",
      expected,
      observed: { mediaId: assertion.mediaId },
      reason: "VISUAL_ANALYZER_UNAVAILABLE",
      detail: `visual analysis is unavailable for media ${assertion.mediaId}`,
    };
  }
  const candidates = labelKind === "scene"
    ? media.visual.scenes.filter((scene) => scene.label !== undefined).map((scene) => ({
      label: scene.label!,
      confidence: scene.confidence ?? 0,
    }))
    : media.visual.subjects.map((subject) => ({ label: subject.label, confidence: subject.confidence }));
  const matching = candidates.find((candidate) => candidate.label.toLowerCase() === assertion.label.toLowerCase());
  const passed = matching !== undefined && matching.confidence >= (assertion.minConfidence ?? 0);
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed: { mediaId: assertion.mediaId, matches: candidates },
    ...(passed ? {} : { reason: "VISUAL_CONTENT_NOT_FOUND" }),
    detail: passed
      ? `observed ${labelKind} content ${assertion.label} in media ${assertion.mediaId}`
      : `expected ${labelKind} content ${assertion.label} in media ${assertion.mediaId}`,
  };
}

function verifyDuration(transaction: EditTransaction, assertion: DurationAssertion): VerificationCheck {
  const toleranceSeconds = assertion.toleranceSeconds ?? 0;
  const expected = {
    target: assertion.target,
    expectedSeconds: assertion.expectedSeconds,
    toleranceSeconds,
  };
  const observed = transaction.attemptedAfter.timeline.duration;
  const passed = Math.abs(observed - assertion.expectedSeconds) <= toleranceSeconds;
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected,
    observed,
    ...(passed ? {} : { reason: "DURATION_MISMATCH" }),
    detail: passed
      ? `observed timeline duration ${observed}s`
      : `expected timeline duration ${assertion.expectedSeconds}s ±${toleranceSeconds}s, observed ${observed}s`,
  };
}

function verifyStream(transaction: EditTransaction, assertion: StreamAssertion): VerificationCheck {
  const observed = transaction.attemptedAfter.timeline.clips.some((clip) => {
    const media = clip.mediaId
      ? transaction.attemptedAfter.media.find((candidate) => candidate.mediaId === clip.mediaId)
      : undefined;
    if (assertion.target === "audio") return media?.mediaKind === "audio" || media?.audio !== undefined;
    return media?.mediaKind === "video" || media === undefined;
  });
  const passed = observed === assertion.expected;
  return {
    name: assertion.type,
    passed,
    status: passed ? "passed" : "failed",
    expected: { target: assertion.target, expected: assertion.expected },
    observed,
    ...(passed ? {} : { reason: "STREAM_PRESENCE_MISMATCH" }),
    detail: passed
      ? `observed ${assertion.target} stream presence ${observed}`
      : `expected ${assertion.target} stream presence ${assertion.expected}, observed ${observed}`,
  };
}

function verifyStructure(transaction: EditTransaction, assertion: StructureAssertion): VerificationCheck {
  const expected = {
    requirement: assertion.requirement,
    ...(assertion.mediaId !== undefined ? { mediaId: assertion.mediaId } : {}),
    ...(assertion.occurrenceId !== undefined ? { occurrenceId: assertion.occurrenceId } : {}),
    ...(assertion.operationType !== undefined ? { operationType: assertion.operationType } : {}),
  };
  let observed = false;
  if (assertion.requirement === "media-present" && assertion.mediaId !== undefined) {
    observed = transaction.attemptedAfter.media.some((media) => media.mediaId === assertion.mediaId);
  }
  if (assertion.requirement === "occurrence-present" && assertion.occurrenceId !== undefined) {
    observed = transaction.attemptedAfter.timeline.clips.some((clip) => clip.id === assertion.occurrenceId);
  }
  if (assertion.requirement === "operation-present" && assertion.operationType !== undefined) {
    observed = transaction.planned.some((operation) => operation.type === assertion.operationType);
  }
  return {
    name: assertion.type,
    passed: observed,
    status: observed ? "passed" : "failed",
    expected,
    observed,
    ...(observed ? {} : { reason: "STRUCTURE_EXPECTATION_NOT_MET" }),
    detail: observed ? "observed the expected project structure" : "expected project structure was not observed",
  };
}

function audioStateIsValid(transaction: EditTransaction): boolean {
  if (transaction.after.timeline.clips.some((clip) => {
    const fadeIn = clip.fadeIn ?? 0;
    const fadeOut = clip.fadeOut ?? 0;
    return (clip.gainDb !== undefined && !Number.isFinite(clip.gainDb))
      || !Number.isFinite(fadeIn)
      || !Number.isFinite(fadeOut)
      || fadeIn < 0
      || fadeOut < 0
      || fadeIn + fadeOut > clip.duration;
  })) return false;

  return transaction.planned.every((operation) => {
    if (operation.type === "set-gain") {
      const clip = transaction.after.timeline.clips.find((candidate) => candidate.id === operation.clipId);
      return clip?.gainDb === operation.gainDb;
    }
    if (operation.type === "timeline.audio.fades") {
      const clip = transaction.after.timeline.clips.find((candidate) => candidate.id === operation.clipId);
      return clip?.fadeIn === operation.fadeIn && clip.fadeOut === operation.fadeOut;
    }
    if (operation.type === "timeline.media.add" && operation.role === "music") {
      const clip = transaction.after.timeline.clips.find((candidate) => candidate.id === operation.occurrenceId);
      return clip?.start === operation.start
        && clip.duration === operation.duration
        && clip.track === operation.targetLane;
    }
    return true;
  });
}

function audioStateDetail(transaction: EditTransaction): string {
  return audioStateIsValid(transaction)
    ? "music placement, duration, gain, and fades match the planned audio state"
    : "music placement, duration, gain, or fades do not match the planned audio state";
}
