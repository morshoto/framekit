import type { RationalTime, TimeRange } from "../domain/primitives.js";

export interface RationalParts {
  value: bigint;
  timescale: bigint;
}

export function parseRational(time: RationalTime, errorCode: string): RationalParts {
  if (!/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale)) {
    throw new Error(`${errorCode}: rational time requires integer value and timescale`);
  }
  const value = BigInt(time.value);
  const timescale = BigInt(time.timescale);
  if (timescale <= 0n) throw new Error(`${errorCode}: rational timescale must be positive`);
  return { value, timescale };
}

export function addRationalTimes(left: RationalTime, right: RationalTime, errorCode = "ANALYSIS_INVALID"): RationalTime {
  const leftParts = parseRational(left, errorCode);
  const rightParts = parseRational(right, errorCode);
  return normalizeRational(
    leftParts.value * rightParts.timescale + rightParts.value * leftParts.timescale,
    leftParts.timescale * rightParts.timescale,
  );
}

export function isWithinClip(
  position: RationalParts,
  startTime: RationalTime,
  durationTime: RationalTime,
): boolean {
  const start = parseRational(startTime, "INVALID_PROJECT_STATE");
  const duration = parseRational(durationTime, "INVALID_PROJECT_STATE");
  if (duration.value < 0n) throw new Error("INVALID_PROJECT_STATE: clip duration cannot be negative");
  const startsBeforeOrAtPosition = start.value * position.timescale <= position.value * start.timescale;
  const endValue = start.value * duration.timescale + duration.value * start.timescale;
  const endTimescale = start.timescale * duration.timescale;
  const positionBeforeEnd = position.value * endTimescale < endValue * position.timescale;
  return startsBeforeOrAtPosition && positionBeforeEnd;
}

export function rationalDifferenceSeconds(left: RationalParts, right: RationalParts): number {
  const numerator = left.value * right.timescale - right.value * left.timescale;
  const denominator = left.timescale * right.timescale;
  const seconds = Number(numerator) / Number(denominator);
  if (!Number.isFinite(seconds)) {
    throw new Error("INVALID_TIMELINE_POSITION: relative media time is outside the supported analysis range");
  }
  return seconds;
}

function normalizeRational(value: bigint, timescale: bigint): RationalTime {
  const divisor = greatestCommonDivisor(value < 0n ? -value : value, timescale);
  return { value: String(value / divisor), timescale: String(timescale / divisor) };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}

export function translateRationalRange(
  clipStartTime: RationalTime,
  clipStart: number,
  sourceRange: TimeRange,
): TimeRange {
  if (!sourceRange.startTime || !sourceRange.durationTime) {
    throw new Error("ANALYSIS_INVALID: filler range is missing rational timing");
  }
  return {
    start: clipStart + sourceRange.start,
    end: clipStart + sourceRange.end,
    startTime: addRationalTimes(clipStartTime, sourceRange.startTime),
    durationTime: { ...sourceRange.durationTime },
  };
}
