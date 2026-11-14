import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateResults } from '../../scripts/ci/check-results.mjs';

function results(changed = 'true') {
  return Object.fromEntries(['lint', 'test', 'nix-fixture', 'consumer-runtime', 'swift', 'docs-changes', 'docs-foundation', 'docs-export'].map(id => [id, {
    result: 'success', ...(id === 'docs-changes' ? { outputs: { changed } } : {}),
  }]));
}

test('accepts all expected jobs passing', () => {
  assert.deepEqual(evaluateResults(results()), []);
});

for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
  test(`rejects mandatory job result ${outcome}`, () => {
    const jobs = results();
    jobs['consumer-runtime'].result = outcome;
    assert.ok(evaluateResults(jobs).some(error => error.includes('consumer-runtime')));
  });
}

test('rejects missing mandatory jobs', () => {
  const jobs = results();
  delete jobs.test;
  assert.ok(evaluateResults(jobs).some(error => error.includes('test')));
});

test('only permits Docs skips with a successful explicit negative scope decision', () => {
  const jobs = results('false');
  jobs['docs-foundation'].result = jobs['docs-export'].result = 'skipped';
  assert.deepEqual(evaluateResults(jobs), []);
  for (const changed of ['true', '', undefined]) {
    jobs['docs-changes'].outputs.changed = changed;
    assert.ok(evaluateResults(jobs).length > 0);
  }
});

test('rejects failed detection even if fallback Docs jobs pass', () => {
  const jobs = results();
  jobs['docs-changes'].result = 'failure';
  assert.ok(evaluateResults(jobs).some(error => error.includes('docs-changes')));
});

test('rejects absent detection outputs rather than approving skipped coverage', () => {
  const jobs = results();
  delete jobs['docs-changes'].outputs;
  assert.ok(evaluateResults(jobs).some(error => error.includes('scope')));
});

test('does not hide failures in Docs jobs when scope is negative', () => {
  const jobs = results('false');
  jobs['docs-foundation'].result = 'failure';
  assert.ok(evaluateResults(jobs).some(error => error.includes('docs-foundation')));
});

test('rejects unaccounted additional failed jobs', () => {
  const jobs = results();
  jobs.additional = { result: 'failure' };
  assert.ok(evaluateResults(jobs).some(error => error.includes('additional')));
});
