import { fileURLToPath } from 'node:url';
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
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(runner), '/missing/speech', '/missing/music', '/missing/output'], {stdio: 'pipe'}), /ENOENT/);
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

test('reports recognition retention without equating it with listening', async () => {
  const { recognitionRetention } = await import('../../../scripts/benchmarks/ai-editing/speech-consistency.mjs');
  const result = recognitionRetention(['Hello,', 'there', 'friend'], ['hello', 'friend']);
  assert.equal(result.commonWords, 2);
  assert.equal(result.baselineWords, 3);
  assert.equal(result.retention, 2 / 3);
  assert.equal(result.intelligibility, 'unavailable');
  assert.equal(recognitionRetention([], ['invented']).retention, null);
  assert.throws(() => recognitionRetention(['...'], ['hello']), /word/i);
});

test('recognition proxy is fixed to the measured renders and is not acceptance', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../../../scripts/benchmarks/ai-editing/speech-proxy-case.json', import.meta.url)));
  assert.match(config.baselineSha256, /^[a-f0-9]{64}$/);
  assert.match(config.mixedSha256, /^[a-f0-9]{64}$/);
  assert.equal(config.minimumExploratoryRetention, 0.9);
  assert.equal(config.secondaryModel, 'mlx-community/whisper-large-v3-turbo');
  assert.deepEqual(config.activeMusicSeconds, [2,8]);
  assert.match(config.activeWindowDesignation, /post hoc/i);
  assert.match(config.limitation, /not.*intelligibility/i);
});

test('speech proxy runner checks media identity before recognition', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-speech-proxy.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath,[fileURLToPath(runner),'/missing/a','/missing/b','python'],{stdio:'pipe'}), /ENOENT/);
});

test('allows explicit bounded gain for an exploratory comparison', async () => {
  const { selectedGain } = await import('../../../scripts/benchmarks/ai-editing/music-quality.mjs');
  assert.equal(selectedGain(undefined, -24), -24);
  assert.equal(selectedGain('-36', -24), -36);
  assert.throws(() => selectedGain('1', -24), /gain/i);
  assert.throws(() => selectedGain('bad', -24), /gain/i);
  assert.throws(() => selectedGain('  ', -24), /gain/i);
});

test('creates nested output directories without accepting an existing output', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareOutputDirectory } = await import('../../../scripts/benchmarks/ai-editing/music-quality.mjs');
  const root = await mkdtemp(join(tmpdir(), 'framekit-music-output-'));
  try {
    const output = join(root, 'new-parent', 'output');
    await prepareOutputDirectory(output);
    await assert.rejects(prepareOutputDirectory(output), { code: 'EEXIST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approved music probe verifies both inputs before creating output', async () => {
  const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareApprovedMusicOutput } = await import('../../../scripts/benchmarks/ai-editing/music-approved-preflight.mjs');
  const root = await mkdtemp(join(tmpdir(), 'framekit-music-preflight-'));
  try {
    const speech=join(root,'speech'), music=join(root,'music'), output=join(root,'output');
    await writeFile(speech,'speech'); await writeFile(music,'music');
    const sha=(s)=>createHash('sha256').update(s).digest('hex');
    await assert.rejects(prepareApprovedMusicOutput(speech,music,output,sha('speech'),'0'.repeat(64)), /digest mismatch/i);
    await assert.rejects(stat(output), {code:'ENOENT'});
    await prepareApprovedMusicOutput(speech,music,output,sha('speech'),sha('music'));
    await assert.rejects(prepareApprovedMusicOutput(speech,music,output,sha('speech'),sha('music')), {code:'EEXIST'});
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('labels the quieter gain comparison as exploratory and post hoc', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../../../scripts/benchmarks/ai-editing/music-corpus.json', import.meta.url)));
  assert.equal(config.followUp.gainDb, -36);
  assert.match(config.followUp.designation, /post hoc/i);
});

test('selects only pinned recognition proxy variants', async () => {
  const { proxyVariant } = await import('../../../scripts/benchmarks/ai-editing/speech-consistency.mjs');
  const config = {baselineSha256:'a'.repeat(64),mixedSha256:'b'.repeat(64),followUpMixedSha256:'c'.repeat(64)};
  assert.equal(proxyVariant(config, undefined).mixedSha256, 'b'.repeat(64));
  assert.equal(proxyVariant(config, 'standard').mixedSha256, 'b'.repeat(64));
  assert.equal(proxyVariant(config, 'quiet').mixedSha256, 'c'.repeat(64));
  assert.throws(() => proxyVariant(config, 'unknown'), /variant/i);
});

test('recognition proxy accepts only explicitly configured models', async () => {
  const { proxyModel } = await import('../../../scripts/benchmarks/ai-editing/speech-consistency.mjs');
  const config = {model:'tiny',secondaryModel:'large'};
  assert.equal(proxyModel(config, undefined),'tiny');
  assert.equal(proxyModel(config, 'secondary'),'large');
  assert.throws(() => proxyModel(config, 'other'), /model/i);
  assert.throws(() => proxyModel({model:'tiny'}, 'secondary'), /model/i);
});

test('restricts speech proxy to the active music window and counts boundary words', async () => {
  const { proxyWindowWords } = await import('../../../scripts/benchmarks/ai-editing/speech-consistency.mjs');
  const words = [
    {text:'before', start:0.5, end:1},
    {text:'crossing', start:1.9, end:2.1},
    {text:'inside', start:2.1, end:2.5},
    {text:'end', start:7.9, end:8.1},
    {text:'after', start:9, end:9.5},
  ];
  const result = proxyWindowWords(words,{start:2,end:8});
  assert.deepEqual(result.tokens,['inside']);
  assert.equal(result.excludedBoundaryWords,2);
  assert.equal(result.outsideWords,2);
  assert.throws(() => proxyWindowWords([{text:'bad',start:2,end:1}],{start:2,end:8}), /word/i);
});
