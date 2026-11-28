import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Create missing parents while preserving the requirement that output is new. */
export async function prepareOutputDirectory(output) {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
}

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

/** Estimate alignment relative to an expected start, in whole frames. */
export function estimateOffsetFrames(reference, rendered, expectedStart, frameSamples, searchFrames) {
  if (!reference.length || !Number.isInteger(expectedStart) || !Number.isInteger(frameSamples) || frameSamples < 1 || !Number.isInteger(searchFrames) || searchFrames < 0) throw new Error('Invalid alignment');
  let best = null;
  for (let offset = -searchFrames; offset <= searchFrames; offset++) {
    const start = expectedStart + offset * frameSamples;
    if (start < 0 || start + reference.length > rendered.length) continue;
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < reference.length; i++) {
      const x = reference[i], y = rendered[start + i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid alignment samples');
      xy += x*y; xx += x*x; yy += y*y;
    }
    if (!xx || !yy) continue;
    const correlation = xy / Math.sqrt(xx*yy);
    if (best === null || correlation > best.correlation) best = {offsetFrames:offset, correlation};
  }
  return best;
}

/** Validate optional exploratory gain without amplifying the source. */
export function selectedGain(argument, fallback) {
  const gain = argument === undefined ? fallback : Number(argument);
  if (!Number.isFinite(gain) || gain > 0 || gain < -96 || (typeof argument === 'string' && argument.trim() === '')) throw new Error('Invalid music gain');
  return gain;
}
