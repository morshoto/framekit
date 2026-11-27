import type { NarrativeCutCandidate, RationalTime, TimelineIr, TimelineIrEditOperation } from "@framekit/runtime";

type Range = Pick<NarrativeCutCandidate, "occurrenceId" | "sourceRange" | "sequenceRange">;
type Fraction = { value: bigint; scale: bigint };

function fraction(time: RationalTime | undefined): Fraction {
  if (!time || !/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale) || BigInt(time.timescale) === 0n) {
    throw new Error("CUT_PREVIEW_UNAVAILABLE: exact rational timing is required");
  }
  return { value: BigInt(time.value), scale: BigInt(time.timescale) };
}
function compare(a: Fraction, b: Fraction): number {
  const difference = a.value * b.scale - b.value * a.scale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function add(a: Fraction, b: Fraction): Fraction { return { value: a.value * b.scale + b.value * a.scale, scale: a.scale * b.scale }; }
function subtract(a: Fraction, b: Fraction): Fraction { return { value: a.value * b.scale - b.value * a.scale, scale: a.scale * b.scale }; }
function time(a: Fraction): RationalTime {
  let x = a.value < 0n ? -a.value : a.value; let y = a.scale;
  while (y) [x, y] = [y, x % y];
  const divisor = x || 1n;
  return { value: String(a.value / divisor), timescale: String(a.scale / divisor) };
}

/** Build an exact single-clip headless cut; reject content whose ripple is not modeled. */
export function reviewedCutOperations(timeline: TimelineIr, candidate: Range, planDigest: string): TimelineIrEditOperation[] {
  const sequence = timeline.sequence;
  const clip = sequence.occurrences[0];
  if (sequence.occurrences.length !== 1 || !clip || clip.id !== candidate.occurrenceId || clip.track !== 0
    || clip.role !== "video" || !clip.mediaId || clip.attachedTo || clip.fadeIn !== undefined || clip.fadeOut !== undefined
    || sequence.storyElements.length || sequence.markers.length || sequence.captions.length || sequence.titles?.length || sequence.transitions?.length) {
    throw new Error("CUT_PREVIEW_UNAVAILABLE: only an isolated primary video occurrence is supported");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(planDigest)) throw new Error("CUT_PREVIEW_UNAVAILABLE: invalid plan identity");
  const start = fraction(candidate.sequenceRange.startTime); const duration = fraction(candidate.sequenceRange.durationTime);
  const clipStart = fraction(clip.startTime); const clipDuration = fraction(clip.durationTime);
  const sourceStart = fraction(clip.sourceStartTime ?? { value: "0", timescale: "1" });
  const sourceCut = fraction(candidate.sourceRange.startTime); const sourceDuration = fraction(candidate.sourceRange.durationTime);
  const frame = fraction(sequence.frameDuration); const origin = fraction(sequence.frameGridOrigin ?? { value: "0", timescale: "1" });
  const offset = subtract(start, clipStart); const end = add(offset, duration);
  if (duration.value <= 0n || offset.value <= 0n || compare(end, clipDuration) >= 0 || frame.value <= 0n
    || (subtract(start, origin).value * frame.scale) % (subtract(start, origin).scale * frame.value) !== 0n
    || (duration.value * frame.scale) % (duration.scale * frame.value) !== 0n) {
    throw new Error("CUT_PREVIEW_UNAVAILABLE: cut must be inside the clip and frame aligned");
  }
  if (compare(sourceCut, add(sourceStart, offset)) !== 0 || compare(sourceDuration, duration) !== 0) {
    throw new Error("CUT_PREVIEW_UNAVAILABLE: source range does not match the occurrence");
  }
  const removed = `decision-cut-${planDigest.slice(7, 23)}-removed`;
  const right = `decision-cut-${planDigest.slice(7, 23)}-right`;
  if (clip.id === removed || clip.id === right) throw new Error("CUT_PREVIEW_UNAVAILABLE: generated occurrence identity conflicts");
  return [
    { type: "split-occurrence", occurrenceId: clip.id, splitOffsetTime: time(offset), newOccurrenceId: removed },
    { type: "split-occurrence", occurrenceId: removed, splitOffsetTime: time(duration), newOccurrenceId: right },
    { type: "remove-occurrence", occurrenceId: removed },
    { type: "move-occurrence", occurrenceId: right, startTime: time(start) },
  ];
}
