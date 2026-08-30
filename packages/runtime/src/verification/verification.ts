import type { EditTransaction, WorkflowOperation } from "../domain/editing.js";
import type {
  VerificationCheck,
  VerificationEngine,
  VerificationPolicy,
  VerificationReport,
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

    return { passed: checks.every((check) => check.passed), checks };
  }
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
