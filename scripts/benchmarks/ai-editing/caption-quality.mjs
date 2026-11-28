/** Word error rate with case and outer punctuation normalized; no semantic equivalence is assumed. */
export function compareTranscript(reference, hypothesis) {
  const normalize = (words) => {
    if (!Array.isArray(words)) throw new Error('Expected word array');
    return words.map((word) => {
      if (typeof word !== 'string') throw new Error('Invalid word');
      const value = word.normalize('NFKC').toLocaleLowerCase('und').replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
      if (!value || /\s/u.test(value)) throw new Error('Invalid word');
      return value;
    });
  };
  const expected = normalize(reference);
  const actual = normalize(hypothesis);
  let row = Array.from({length: actual.length + 1}, (_, i) => ({ errors: i, substitutions: 0, deletions: 0, insertions: i }));
  for (let i = 1; i <= expected.length; i++) {
    const next = [{ errors: i, substitutions: 0, deletions: i, insertions: 0 }];
    for (let j = 1; j <= actual.length; j++) {
      const match = expected[i - 1] === actual[j - 1];
      const diagonal = { ...row[j - 1], errors: row[j - 1].errors + (match ? 0 : 1), substitutions: row[j - 1].substitutions + (match ? 0 : 1) };
      const deletion = { ...row[j], errors: row[j].errors + 1, deletions: row[j].deletions + 1 };
      const insertion = { ...next[j - 1], errors: next[j - 1].errors + 1, insertions: next[j - 1].insertions + 1 };
      next.push([diagonal, deletion, insertion].reduce((best, candidate) => candidate.errors < best.errors ? candidate : best));
    }
    row = next;
  }
  const result = row[actual.length];
  return { ...result, referenceWords: expected.length, hypothesisWords: actual.length, wordErrorRate: expected.length ? result.errors / expected.length : null };
}

/** Exploratory text comparison: AMI's automatic alignment is not a verified timestamp reference. */
export function assessAmiTranscript(reference, recognized, offset, duration) {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid window');
  const end = offset + duration;
  const relevant = reference.filter((word) => word.start < end && word.end > offset);
  const full = relevant.filter((word) => word.start >= offset && word.end <= end)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  let overlappingReferencePairs = 0;
  for (let i = 0; i < full.length; i++) {
    for (let j = i + 1; j < full.length && full[j].start < full[i].end; j++) {
      if (full[i].speaker !== full[j].speaker) overlappingReferencePairs++;
    }
  }
  const tokens = recognized.flatMap((word) => word.text.trim().split(/\s+/u)).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const result = compareTranscript(full.map((word) => word.text), tokens);
  return { ...result, referenceBoundaryWordsExcluded: relevant.length - full.length, overlappingReferencePairs,
    lowConfidenceWords: recognized.filter((word) => word.confidence < 0.8).length,
    timingStatus: 'unavailable',
    limitation: 'Reference timings are automatically aligned; cross-speaker overlap makes linear word order ambiguous.' };
}
