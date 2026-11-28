import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureMix } from '../../../scripts/benchmarks/ai-editing/music-quality.mjs';

test('reports isolated component ratio and mix error without claiming intelligibility', () => {
  const speech = [0.2, -0.2, 0.2, -0.2];
  const music = [0.1, 0.1, -0.1, -0.1];
  const mix = speech.map((x, i) => x + music[i]);
  const result = measureMix(speech, music, mix);
  assert.ok(Math.abs(result.speechToMusicDb - 6.0206) < 0.001);
  assert.ok(result.mixResidualRms < 1e-12);
  assert.equal(result.intelligibility, 'unavailable');
  assert.equal(result.clippedSamples, 0);
});

test('reports clipping and unavailable ratios for silent components', () => {
  const result = measureMix([0, 0], [0.2, -0.2], [1, -1]);
  assert.equal(result.speechToMusicDb, null);
  assert.equal(result.clippedSamples, 2);
  assert.ok(result.mixResidualRms > 0);
});

test('rejects mismatched, empty and non-finite measurements', () => {
  assert.throws(() => measureMix([], [], []), /samples/i);
  assert.throws(() => measureMix([0], [0, 0], [0]), /samples/i);
  assert.throws(() => measureMix([NaN], [0], [0]), /samples/i);
});
