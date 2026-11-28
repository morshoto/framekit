import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareProviderCuts } from '../../../scripts/benchmarks/ai-editing/evidence-quality.mjs';

const digest = 'a'.repeat(64);
const candidate = {start: 5.2, end: 5.7};
const evidence = {sourceSha256: digest, coverage: {start: 0, end: 10}, words: [{text: 'regarding', start: 5.6, end: 6.2, confidence: 0.3}]};

test('surfaces even low-confidence provider words that overlap a candidate', () => {
  const result = compareProviderCuts([candidate], digest, evidence);
  assert.equal(result.status, 'disagreement');
  assert.equal(result.conflicts[0].words[0].confidence, 0.3);
  assert.equal(result.safety, 'unverified');
});

test('does not infer safety from absent or partially covered secondary evidence', () => {
  assert.equal(compareProviderCuts([candidate], digest, {...evidence, coverage: {start: 0, end: 5.5}}).status, 'unavailable');
  const result = compareProviderCuts([candidate], digest, {...evidence, words: []});
  assert.equal(result.status, 'no-overlap-observed');
  assert.equal(result.safety, 'unverified');
  assert.equal(compareProviderCuts([], digest, evidence).status, 'unavailable');
});

test('rejects mismatched source identities and invalid timing', () => {
  assert.equal(compareProviderCuts([candidate], 'b'.repeat(64), evidence).status, 'unavailable');
  assert.throws(() => compareProviderCuts([{start: 2, end: 1}], digest, evidence), /range/i);
});

test('provider comparison case fixes media, cut and context before execution', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../../../scripts/benchmarks/ai-editing/disagreement-case.json', import.meta.url)));
  assert.equal(config.meeting, 'TS3003a');
  assert.deepEqual(config.secondaryWindowSeconds, [72, 82]);
  assert.equal(config.candidate.start, 77.2);
  assert.equal(config.secondaryModel, 'mlx-community/whisper-large-v3-turbo');
  assert.match(config.interpretation, /not proof/i);
});

test('provider runner verifies source before invoking a model', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-disagreement.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath, [runner.pathname, '/missing/source', 'python'], {stdio:'pipe'}), /ENOENT/);
});
