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

    if (transaction.planned.some(isConstructionOperation)) {
      checks.push({
        name: "construction-state",
        passed: constructionStateIsValid(transaction),
        detail: constructionStateDetail(transaction),
      });
    }

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

function isConstructionOperation(operation: WorkflowOperation): boolean {
  return operation.type === "media.import"
    || operation.type === "timeline.media.add"
    || operation.type === "timeline.media.move"
    || operation.type === "timeline.media.replace"
    || operation.type === "timeline.media.remove"
    || operation.type === "timeline.transition.add"
    || operation.type === "timeline.audio.attach"
    || operation.type === "timeline.audio.mix";
}

function constructionStateIsValid(transaction: EditTransaction): boolean {
  const expectedClips = expectedConstructionClips(transaction);
  return transaction.planned.every((operation) => {
    if (operation.type === "media.import") {
      const media = transaction.after.media.find((candidate) => candidate.mediaId === operation.mediaId);
      return media?.source === operation.source
        && media.mediaKind === operation.mediaKind
        && media.duration === operation.duration
        && media.sourceDigest === operation.sourceDigest;
    }
    if (operation.type === "timeline.media.add"
      || operation.type === "timeline.media.move"
      || operation.type === "timeline.media.replace"
      || operation.type === "timeline.media.remove"
      || operation.type === "timeline.audio.attach") {
      const expected = expectedClips.get(operation.occurrenceId);
      const actual = transaction.after.timeline.clips.find((candidate) => candidate.id === operation.occurrenceId);
      return expected === undefined ? actual === undefined : actual !== undefined && sameConstructionClip(actual, expected);
    }
    if (operation.type === "timeline.transition.add") {
      const element = transaction.after.timeline.storyElements.find(({ id }) => id === operation.transitionId);
      return element?.kind === "transition"
        && element.assetId === operation.assetId
        && element.beforeClipId === operation.beforeClipId
        && element.afterClipId === operation.afterClipId
        && element.duration === operation.duration;
    }
    if (operation.type === "timeline.audio.mix") {
      const clip = transaction.after.timeline.clips.find((candidate) => candidate.id === operation.clipId);
      return clip !== undefined
        && (operation.gainDb === undefined || clip.gainDb === operation.gainDb)
        && (operation.fadeIn === undefined || clip.fadeIn === operation.fadeIn)
        && (operation.fadeOut === undefined || clip.fadeOut === operation.fadeOut);
    }
    return true;
  });
}

function constructionStateDetail(transaction: EditTransaction): string {
  return constructionStateIsValid(transaction)
    ? "imported media and timeline construction operations match the requested state"
    : "imported media or timeline construction operations do not match the requested state";
}

function timelineTrack(targetLane: "primary" | number | undefined, fallback: number): number {
  return targetLane === "primary" ? 0 : targetLane ?? fallback;
}

interface ConstructionClipState {
  mediaId?: string;
  start: number;
  duration: number;
  track: number;
  attachedTo?: string;
}

function expectedConstructionClips(transaction: EditTransaction): Map<string, ConstructionClipState> {
  const clips = new Map<string, ConstructionClipState>(transaction.before.timeline.clips.map((clip) => [clip.id, {
    mediaId: clip.mediaId,
    start: clip.start,
    duration: clip.duration,
    track: clip.track,
    attachedTo: clip.attachedTo,
  }]));
  const media = new Map(transaction.before.media.map((item) => [item.mediaId, item]));

  for (const operation of transaction.planned) {
    if (operation.type === "media.import") {
      media.set(operation.mediaId, operation);
      continue;
    }
    if (operation.type === "timeline.media.add") {
      clips.set(operation.occurrenceId, {
        mediaId: operation.mediaId,
        start: operation.start,
        duration: operation.duration,
        track: timelineTrack(operation.targetLane, 0),
      });
      continue;
    }
    if (operation.type === "timeline.title.add") {
      clips.set(operation.occurrenceId, {
        start: operation.start,
        duration: operation.duration,
        track: operation.targetLane,
      });
      continue;
    }
    if (operation.type === "timeline.media.move") {
      const clip = clips.get(operation.occurrenceId);
      if (clip) {
        clip.start = operation.start;
        clip.track = timelineTrack(operation.targetLane, clip.track);
      }
      continue;
    }
    if (operation.type === "timeline.media.replace") {
      const clip = clips.get(operation.occurrenceId);
      if (clip) {
        clip.mediaId = operation.mediaId;
        if (operation.duration !== undefined) clip.duration = operation.duration;
      }
      continue;
    }
    if (operation.type === "trim-clip") {
      const clip = clips.get(operation.clipId);
      if (clip) {
        clip.duration = operation.durationTime
          ? Number(operation.durationTime.value) / Number(operation.durationTime.timescale)
          : operation.duration;
      }
      continue;
    }
    if (operation.type === "timeline.audio.attach") {
      const target = clips.get(operation.targetClipId);
      const source = media.get(operation.mediaId);
      const duration = operation.duration ?? source?.duration;
      if (target && duration !== undefined) {
        clips.set(operation.occurrenceId, {
          mediaId: operation.mediaId,
          start: target.start + (operation.startOffset ?? 0),
          duration,
          track: -1,
          attachedTo: operation.targetClipId,
        });
      }
      continue;
    }
    if (operation.type === "timeline.media.remove") {
      const removedIds = new Set([operation.occurrenceId]);
      for (const [id, clip] of clips) {
        if (clip.attachedTo === operation.occurrenceId) removedIds.add(id);
      }
      for (const id of removedIds) clips.delete(id);
      continue;
    }
    if (operation.type === "ripple-delete") {
      applyExpectedRippleDelete(clips, operation.range.start, operation.range.end);
    }
  }
  return clips;
}

function sameConstructionClip(actual: { mediaId?: string; start: number; duration: number; track: number; attachedTo?: string }, expected: ConstructionClipState): boolean {
  return actual.mediaId === expected.mediaId
    && actual.start === expected.start
    && actual.duration === expected.duration
    && actual.track === expected.track
    && actual.attachedTo === expected.attachedTo;
}

function applyExpectedRippleDelete(clips: Map<string, ConstructionClipState>, start: number, end: number): void {
  const removedDuration = end - start;
  for (const [id, clip] of clips) {
    const clipEnd = clip.start + clip.duration;
    if (clipEnd <= start) continue;
    if (clip.start >= end) {
      clip.start -= removedDuration;
      continue;
    }
    const overlap = Math.min(clipEnd, end) - Math.max(clip.start, start);
    clip.duration -= overlap;
    if (clip.duration <= 0) {
      clips.delete(id);
    } else {
      clip.start = clip.start < start ? clip.start : start;
    }
  }
}
