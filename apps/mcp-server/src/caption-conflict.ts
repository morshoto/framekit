import type { RationalTime, TimelineIrTitle } from "@framekit/runtime";

/** Compare exact half-open title ranges; touching boundaries do not overlap. */
function endsAfter(start: RationalTime, duration: RationalTime, otherStart: RationalTime): boolean {
  const numerator = BigInt(start.value) * BigInt(duration.timescale) + BigInt(duration.value) * BigInt(start.timescale);
  const denominator = BigInt(start.timescale) * BigInt(duration.timescale);
  return numerator * BigInt(otherStart.timescale) > BigInt(otherStart.value) * denominator;
}

export function captionTitlesConflict(existing: readonly TimelineIrTitle[], proposed: readonly TimelineIrTitle[]): boolean {
  return proposed.some((caption) => existing.some((title) => title.lane === caption.lane
    && endsAfter(caption.startTime, caption.durationTime, title.startTime)
    && endsAfter(title.startTime, title.durationTime, caption.startTime)));
}
