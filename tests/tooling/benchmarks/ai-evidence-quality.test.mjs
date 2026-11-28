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
