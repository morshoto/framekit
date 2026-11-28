/** Measure aligned decoded components; numeric balance is not an intelligibility judgment. */
export function measureMix(speech, music, mix) {
  if (!speech.length || speech.length !== music.length || speech.length !== mix.length) throw new Error('Invalid samples');
  let speechSum = 0, musicSum = 0, mixSum = 0, residualSum = 0, peak = 0, clippedSamples = 0;
  for (let i = 0; i < speech.length; i++) {
    const s = speech[i], m = music[i], x = mix[i];
    if (![s, m, x].every(Number.isFinite)) throw new Error('Invalid samples');
    speechSum += s * s; musicSum += m * m; mixSum += x * x;
    residualSum += (x - s - m) ** 2;
    peak = Math.max(peak, Math.abs(x));
    if (Math.abs(x) >= 0.999) clippedSamples++;
  }
  const speechRms = Math.sqrt(speechSum / speech.length);
  const musicRms = Math.sqrt(musicSum / speech.length);
  return {
    samples: speech.length, speechRms, musicRms, mixRms: Math.sqrt(mixSum / speech.length),
    speechToMusicDb: speechRms && musicRms ? 20 * Math.log10(speechRms / musicRms) : null,
    mixResidualRms: Math.sqrt(residualSum / speech.length), peak, clippedSamples,
    intelligibility: 'unavailable',
  };
}
