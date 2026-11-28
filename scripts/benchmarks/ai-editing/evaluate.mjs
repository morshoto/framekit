/** Compare cuts with human-checked word boundaries. Automated alignments are warnings only. */
export function assessCuts(cuts, references, options = {}) {
  const reviewedRanges = options.reviewedRanges ?? [];
  for (const item of [...cuts, ...references, ...reviewedRanges]) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start >= item.end) {
      throw new Error('Invalid time range');
    }
  }
  const overlap = (a, b) => a.start < b.end && b.start < a.end;
  const verified = references.filter((item) => item.verification === 'human-verified');
  const unverified = references.filter((item) => item.verification !== 'human-verified');
  const verifiedSpeechOverlaps = cuts.filter((cut) => verified.some((word) => overlap(cut, word))).length;
  const unverifiedReferenceOverlaps = cuts.filter((cut) => unverified.some((word) => overlap(cut, word))).length;
  return {
    verifiedSpeechOverlaps,
    unverifiedReferenceOverlaps,
    status: verifiedSpeechOverlaps ? 'fail'
      : cuts.length > 0 && !unverifiedReferenceOverlaps && cuts.every((cut) => reviewedRanges.some((range) => range.start <= cut.start && range.end >= cut.end))
        ? 'pass' : 'unavailable',
  };
}
