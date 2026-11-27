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

/** Build an exact headless cut with a fully modeled contiguous primary storyline. */
export function reviewedCutOperations(timeline: TimelineIr, candidate: Range, planDigest: string): TimelineIrEditOperation[] {
  const sequence = timeline.sequence;
  const clips = [...sequence.occurrences].sort((left, right) => compare(fraction(left.startTime), fraction(right.startTime)));
  const matching = clips.filter((item) => item.id === candidate.occurrenceId);
  const clip = matching[0];
  if (matching.length !== 1 || !clip || clips.some((item) => item.track !== 0 || item.role !== "video" || !item.mediaId
    || item.attachedTo || item.fadeIn !== undefined || item.fadeOut !== undefined)
    || sequence.storyElements.length || sequence.markers.length || sequence.captions.length || sequence.titles?.length || sequence.transitions?.length) {
    throw new Error("CUT_PREVIEW_UNAVAILABLE: only a contiguous primary video storyline is supported");
  }
  let cursor = fraction({ value: "0", timescale: "1" });
  for (const item of clips) {
    const itemStart = fraction(item.startTime); const itemDuration = fraction(item.durationTime);
    if (compare(itemStart, cursor) !== 0 || itemDuration.value <= 0n) throw new Error("CUT_PREVIEW_UNAVAILABLE: primary clips must be contiguous");
    cursor = add(cursor, itemDuration);
  }
  if (compare(cursor, fraction(sequence.durationTime)) !== 0) throw new Error("CUT_PREVIEW_UNAVAILABLE: sequence duration must match primary clips");
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
  if (clips.some((item) => item.id === removed || item.id === right)) throw new Error("CUT_PREVIEW_UNAVAILABLE: generated occurrence identity conflicts");
  const later = clips.slice(clips.indexOf(clip) + 1);
  return [
    { type: "split-occurrence", occurrenceId: clip.id, splitOffsetTime: time(offset), newOccurrenceId: removed },
    { type: "split-occurrence", occurrenceId: removed, splitOffsetTime: time(duration), newOccurrenceId: right },
    { type: "remove-occurrence", occurrenceId: removed },
    { type: "move-occurrence", occurrenceId: right, startTime: time(start) },
    ...later.map((item): TimelineIrEditOperation => ({ type: "move-occurrence", occurrenceId: item.id, startTime: time(subtract(fraction(item.startTime), duration)) })),
  ];
}
