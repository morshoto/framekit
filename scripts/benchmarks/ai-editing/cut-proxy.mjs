/** Compare recognized word multisets; order, speech truth and continuity remain unverified. */
export function compareRecognizedWords(baseline, cut) {
  const counts = (words) => {
    if (!Array.isArray(words)) throw new Error('Invalid words');
    const map = new Map();
    for (const word of words) {
      if (typeof word !== 'string') throw new Error('Invalid word');
      const value = word.normalize('NFKC').toLocaleLowerCase('und').replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu,'');
      if (!value || /\s/u.test(value)) throw new Error('Invalid word');
      map.set(value,(map.get(value) ?? 0)+1);
    }
    return map;
  };
  const a = counts(baseline), b = counts(cut);
  let matchedWords = 0;
  const missingTokens = [], addedTokens = [];
  for (const [word,count] of a) { const other = b.get(word) ?? 0; matchedWords += Math.min(count,other); for (let i=0;i<count-other;i++) missingTokens.push(word); }
  for (const [word,count] of b) { const other = a.get(word) ?? 0; for (let i=0;i<count-other;i++) addedTokens.push(word); }
  return {baselineWords:baseline.length,cutWords:cut.length,matchedWords,missingWords:baseline.length-matchedWords,
    addedWords:cut.length-matchedWords,missingTokens,addedTokens,retention:baseline.length ? matchedWords/baseline.length : null,continuity:'unavailable'};
}

/** Remove a half-open range from mono signed 16-bit PCM without rounding samples. */
export function prepareCutPcm(original, firstSample, endSample) {
  if (!Buffer.isBuffer(original) || original.length === 0 || original.length % 2) throw new Error('Invalid PCM');
  const samples = original.length / 2;
  if (!Number.isSafeInteger(firstSample) || !Number.isSafeInteger(endSample) || firstSample < 0 || endSample <= firstSample || endSample > samples) throw new Error('Invalid cut range');
  return {original:Buffer.from(original),cut:Buffer.concat([original.subarray(0,firstSample*2),original.subarray(endSample*2)])};
}

/** Encode mono PCM in a minimal WAV container for the speech backend. */
export function pcmWav(pcm, sampleRate) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 || pcm.length > 0xffffffff-36) throw new Error('Invalid PCM');
  const header=Buffer.alloc(44);
  header.write('RIFF',0); header.writeUInt32LE(pcm.length+36,4); header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
