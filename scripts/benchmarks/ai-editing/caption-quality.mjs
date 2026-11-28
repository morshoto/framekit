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
