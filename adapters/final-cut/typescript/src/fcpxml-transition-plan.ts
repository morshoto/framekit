import type { RationalTime, TimelineIr } from "@framekit/runtime";

type Fraction = { n: bigint; d: bigint };

function fraction(time: RationalTime): Fraction {
  const n = BigInt(time.value);
  const d = BigInt(time.timescale);
  if (d <= 0n) throw new Error("FCPXML_DISSOLVE_INVALID_TIME: nonpositive timescale");
  return { n, d };
}
function combine(a: Fraction, b: Fraction, sign: 1 | -1): Fraction {
  return { n: a.n * b.d + BigInt(sign) * b.n * a.d, d: a.d * b.d };
}
function compare(a: Fraction, b: Fraction): number {
  const delta = a.n * b.d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
function rational(value: Fraction): RationalTime {
  let a = value.n < 0n ? -value.n : value.n;
  let b = value.d;
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a || 1n;
  return { value: String(value.n / divisor), timescale: String(value.d / divisor) };
}
function aligned(time: Fraction, frame: Fraction): boolean {
  return frame.n > 0n && (time.n * frame.d) % (time.d * frame.n) === 0n;
}

/** Plan one pre-cut dissolve without losing the canonical incoming source mapping. */
export function planFcpxmlDissolve(timeline: TimelineIr) {
  const transitions = timeline.sequence.transitions ?? [];
  if (transitions.length !== 1 || transitions[0]!.kind !== "cross-dissolve") throw new Error("FCPXML_DISSOLVE_UNSUPPORTED: exactly one cross-dissolve is required");
  const transition = transitions[0]!;
  const primary = timeline.sequence.occurrences.filter((item) => item.track === 0 && (item.role === undefined || item.role === "video"))
    .sort((a, b) => compare(fraction(a.startTime), fraction(b.startTime)));
  const beforeIndex = primary.findIndex((item) => item.id === transition.beforeOccurrenceId);
  const before = primary[beforeIndex];
  const after = primary[beforeIndex + 1];
  if (beforeIndex < 0 || !before || !after || after.id !== transition.afterOccurrenceId) throw new Error("FCPXML_DISSOLVE_ADJACENCY: endpoints must be adjacent primary clips");
  const duration = fraction(transition.durationTime);
  const cut = fraction(after.startTime);
  const beforeEnd = combine(fraction(before.startTime), fraction(before.durationTime), 1);
  const source = fraction(after.sourceStartTime ?? { value: "0", timescale: "1" });
  const zero = { n: 0n, d: 1n };
  if (compare(duration, zero) <= 0 || compare(duration, fraction(before.durationTime)) > 0 || compare(cut, beforeEnd) !== 0) throw new Error("FCPXML_DISSOLVE_ADJACENCY: transition must fit a contiguous cut");
  const frame = fraction(timeline.sequence.frameDuration);
  if (![duration, cut, source, fraction(before.startTime), fraction(before.durationTime), fraction(after.durationTime)].every((time) => aligned(time, frame))) throw new Error("FCPXML_DISSOLVE_FRAME_ALIGNMENT: transition and clip times must align to the sequence frame grid");
  for (const clip of [before, after]) {
    const video = timeline.resources.find((item) => item.id === clip.mediaId)?.metadata?.streams.find((stream) => stream.kind === "video");
    const rate = video?.frameRate && fraction(video.frameRate);
    if (!rate || rate.n <= 0n || rate.n * frame.n !== rate.d * frame.d) throw new Error("FCPXML_DISSOLVE_FRAME_RATE: source and sequence frame rates must match");
  }
  const afterSourceStart = combine(source, duration, -1);
  const resource = timeline.resources.find((item) => item.id === after.mediaId);
  const sourceFloor = fraction(resource?.sourceRange?.start ?? { value: "0", timescale: "1" });
  if (!resource || compare(afterSourceStart, sourceFloor) < 0) throw new Error("FCPXML_DISSOLVE_HANDLE: insufficient incoming source handle");
  const sourceEnd = combine(source, fraction(after.durationTime), 1);
  const sourceLimit = resource.sourceRange ? combine(fraction(resource.sourceRange.start), fraction(resource.sourceRange.duration), 1) : resource.metadata?.durationTime ? fraction(resource.metadata.durationTime) : undefined;
  if (!sourceLimit || compare(sourceEnd, sourceLimit) > 0) throw new Error("FCPXML_DISSOLVE_HANDLE: incoming source bounds are unavailable or exceeded");
  return {
    id: transition.id,
    beforeId: before.id,
    afterId: after.id,
    startTime: rational(combine(cut, duration, -1)),
    durationTime: rational(duration),
    afterSourceStartTime: rational(afterSourceStart),
    afterDurationTime: rational(combine(fraction(after.durationTime), duration, 1)),
  };
}
