/** Longest common subsequence is a recognition stability proxy, not a listening test. */
export function recognitionRetention(baseline, mixed) {
  const normalize = (words) => words.map((word) => {
    if (typeof word !== 'string') throw new Error('Invalid word');
    const text = word.normalize('NFKC').toLocaleLowerCase('und').replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu,'');
    if (!text || /\s/u.test(text)) throw new Error('Invalid word');
    return text;
  });
  const original = normalize(baseline), candidate = normalize(mixed);
  let row = Array(candidate.length+1).fill(0);
  for (const word of original) {
    const next = [0];
    for (let j=1; j<=candidate.length; j++) next[j] = word === candidate[j-1] ? row[j-1]+1 : Math.max(row[j],next[j-1]);
    row = next;
  }
  const commonWords = row[candidate.length];
  return {baselineWords:original.length,mixedWords:candidate.length,commonWords,
    retention:original.length ? commonWords/original.length : null,intelligibility:'unavailable'};
}

export function proxyVariant(config, variant) {
  if (variant !== undefined && variant !== 'quiet') throw new Error('Unknown proxy variant');
  const mixedSha256 = variant === 'quiet' ? config.followUpMixedSha256 : config.mixedSha256;
  if (!/^[a-f0-9]{64}$/.test(mixedSha256) || !/^[a-f0-9]{64}$/.test(config.baselineSha256)) throw new Error('Invalid proxy variant digest');
  return {baselineSha256:config.baselineSha256,mixedSha256};
}
