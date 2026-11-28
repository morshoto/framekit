/** Recognize the expected typed evidence failure, never an unrelated input error. */
export function isEvidenceRejection(response, expected) {
  if (!['STALE_DECISION_PLAN','MEDIA_CHANGED'].includes(expected) || response?.isError !== true || response.content?.[0]?.type !== 'text') return false;
  try { return JSON.parse(response.content[0].text)?.code === expected; }
  catch { return false; }
}

/** Nearest non-overlapping model words are context, not verified boundaries. */
export function adjacentCandidateWords(cut, words) {
  const before=words.filter((word)=>word.end<=cut.start).sort((a,b)=>b.end-a.end)[0] ?? null;
  const after=words.filter((word)=>word.start>=cut.end).sort((a,b)=>a.start-b.start)[0] ?? null;
  return {before,after};
}

/** Screen an independently generated transcript against candidate cuts; never authorize an edit. */
export function compareProviderCuts(candidates, sourceSha256, evidence) {
  const validRange = (value) => value && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start;
  if (!Array.isArray(candidates) || candidates.some((range) => !validRange(range))) throw new Error('Invalid candidate range');
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !evidence || evidence.sourceSha256 !== sourceSha256 || !validRange(evidence.coverage)
    || !Array.isArray(evidence.words) || evidence.words.some((word) => !validRange(word) || word.start < evidence.coverage.start || word.end > evidence.coverage.end
      || typeof word.text !== 'string' || !word.text.trim() || !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) || !candidates.length
    || candidates.some((cut) => cut.start < evidence.coverage.start || cut.end > evidence.coverage.end)) {
    return {status:'unavailable', conflicts:[], safety:'unverified'};
  }
  const conflicts = candidates.flatMap((cut) => {
    const words = evidence.words.filter((word) => word.start < cut.end && cut.start < word.end);
    return words.length ? [{cut, words}] : [];
  });
  return {status:conflicts.length ? 'disagreement' : 'no-overlap-observed', conflicts, safety:'unverified'};
}
