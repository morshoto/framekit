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

test('pins licensed music and a fixed scenario before evaluation', async () => {
  const { readFile } = await import('node:fs/promises');
  const scenario = JSON.parse(await readFile(new URL('../../../scripts/benchmarks/ai-editing/music-corpus.json', import.meta.url)));
  assert.match(scenario.music.sha256, /^[a-f0-9]{64}$/);
  assert.match(scenario.music.license, /CC BY 4.0/);
  assert.equal(scenario.scenario.gainDb, -24);
  assert.deepEqual(scenario.scenario.placementSeconds, [2, 8]);
  assert.equal(scenario.tolerances.placementFrames, 1);
  assert.equal(scenario.tolerances.gainDb, 1);
  assert.equal(scenario.intelligibility, 'requires independent listening');
});

test('music runner rejects missing source before invoking a renderer', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-music.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', runner.pathname, '/missing/speech', '/missing/music', '/missing/output'], {stdio: 'pipe'}), /ENOENT/);
});

test('finds music placement by normalized correlation at frame resolution', async () => {
  const { estimateOffsetFrames } = await import('../../../scripts/benchmarks/ai-editing/music-quality.mjs');
  const reference = [0.1, -0.3, 0.6, -0.2];
  const rendered = [0, 0, 0, 0, 0.05, -0.15, 0.3, -0.1, 0, 0];
  const result = estimateOffsetFrames(reference, rendered, 2, 2, 2);
  assert.equal(result.offsetFrames, 1);
  assert.ok(result.correlation > 0.999);
  assert.equal(estimateOffsetFrames([0, 0], [0, 0, 0, 0], 1, 1, 1), null);
});
