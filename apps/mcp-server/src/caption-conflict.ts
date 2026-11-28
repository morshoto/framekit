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

/** Replace only explicitly named titles that map one-to-one to exact proposed ranges. */
export function prepareCaptionOperations(existing: readonly TimelineIrTitle[], proposed: readonly TimelineIrTitle[], replaceTitleIds: readonly string[]) {
  const invalid = () => { throw new Error("CAPTION_REPLACEMENT_INVALID: each selected title must uniquely match one proposed caption's lane, start and duration"); };
  if (new Set(replaceTitleIds).size !== replaceTitleIds.length) return invalid();
  const selected = replaceTitleIds.map((id) => {
    const matches = existing.filter((title) => title.id === id);
    if (matches.length !== 1) return invalid();
    return matches[0]!;
  });
  const equalTime = (a: RationalTime, b: RationalTime) => BigInt(a.value) * BigInt(b.timescale) === BigInt(b.value) * BigInt(a.timescale);
  const replacements = new Map<number, TimelineIrTitle>();
  for (const old of selected) {
    const indices = proposed.flatMap((candidate, index) => candidate.lane === old.lane
      && equalTime(candidate.startTime, old.startTime) && equalTime(candidate.durationTime, old.durationTime) ? [index] : []);
    if (indices.length !== 1 || replacements.has(indices[0]!)) return invalid();
    replacements.set(indices[0]!, old);
  }
  const resulting = proposed.map((caption, index) => {
    const old = replacements.get(index);
    return old ? { ...structuredClone(old), text: caption.text } : structuredClone(caption);
  });
  const selectedIds = new Set(replaceTitleIds);
  if (captionTitlesConflict(existing.filter((title) => !selectedIds.has(title.id)), resulting)) {
    throw new Error("CAPTION_PREVIEW_OVERLAP: proposed captions overlap an existing title on the same lane; review and separately remove or replace it before retrying");
  }
  const operations = resulting.flatMap((caption, index) => {
    const old = replacements.get(index);
    return [...(old ? [{ type: "remove-title" as const, titleId: old.id }] : []), { type: "add-title" as const, title: caption }];
  });
  return { operations, replacedTitleIds: [...replaceTitleIds] };
}
