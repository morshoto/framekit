import type { EditTransaction } from "../domain/editing.js";
import type { Clip } from "../domain/project.js";
import type { RationalTime } from "../domain/primitives.js";

const epsilon = 1e-6;
const near = (left: number, right: number) => Math.abs(left - right) <= epsilon;
const consistentTime = (seconds: number, time?: RationalTime) => !time || (/^-?\d+$/.test(time.value)
  && /^\d+$/.test(time.timescale) && Number(time.timescale) > 0 && near(seconds, Number(time.value) / Number(time.timescale)));
const consistentClip = (clip: Clip) => consistentTime(clip.start, clip.startTime)
  && consistentTime(clip.duration, clip.durationTime) && consistentTime(clip.sourceStart ?? 0, clip.sourceStartTime);

/** Resolve split identities from approved cuts, never from the provider's diff alone. */
export function speechContinuityOccurrences(transaction: EditTransaction, before: Clip): Clip[] | undefined {
  const after = transaction.attemptedAfter.timeline.clips;
  const direct = after.find(clip => clip.id === before.id && clip.mediaId === before.mediaId);
  const originalIds = new Set(transaction.before.timeline.clips.map(clip => clip.id));
  // Preserve the existing same-occurrence verification path. New occurrences
  // require a complete, unambiguous source-preserving mapping below.
  if (direct && !after.some(clip => clip.mediaId === before.mediaId && !originalIds.has(clip.id))) return [direct];
  if (!consistentClip(before)) return undefined;
  const cuts: Array<{ start: number; end: number }> = [];
  for (const operation of transaction.planned) {
    if (operation.type !== "ripple-delete" || operation.timelineId !== transaction.before.timeline.id
      || !Number.isFinite(operation.range.start) || !Number.isFinite(operation.range.end)
      || operation.range.start < 0 || operation.range.end <= operation.range.start
      || !consistentTime(operation.range.start, operation.range.startTime)
      || !consistentTime(operation.range.end - operation.range.start, operation.range.durationTime)) return undefined;
    cuts.push(operation.range);
  }
  if (!cuts.length || transaction.attemptedAfter.timeline.id !== transaction.before.timeline.id) return undefined;
  // Descending, disjoint cuts retain their original timeline coordinates.
  if (cuts.some((cut, index) => index > 0 && cut.end > cuts[index - 1]!.start + epsilon)) return undefined;
  let pieces = [{ start: before.start, end: before.start + before.duration }];
  for (const cut of cuts) {
    pieces = pieces.flatMap(piece => {
      if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
      return [
        ...(cut.start > piece.start ? [{ start: piece.start, end: cut.start }] : []),
        ...(cut.end < piece.end ? [{ start: cut.end, end: piece.end }] : []),
      ];
    });
  }
  const mapped: Clip[] = [];
  for (const piece of pieces) {
    const shift = cuts.reduce((total, cut) => total + (cut.end <= piece.start + epsilon ? cut.end - cut.start : 0), 0);
    const matches = after.filter(clip => clip.mediaId === before.mediaId && clip.track === before.track
      && near(clip.start, piece.start - shift) && near(clip.duration, piece.end - piece.start)
      && near(clip.sourceStart ?? 0, (before.sourceStart ?? 0) + piece.start - before.start));
    if (matches.length !== 1 || !consistentClip(matches[0]!) || mapped.some(clip => clip.id === matches[0]!.id)) return undefined;
    mapped.push(matches[0]!);
  }
  return mapped;
}

export function speechWordFitsOccurrences(word: { start: number; end: number }, clips: Clip[], tolerance = 0): boolean {
  return clips.some(clip => word.start >= (clip.sourceStart ?? 0) - tolerance
    && word.end <= (clip.sourceStart ?? 0) + clip.duration + tolerance);
}
