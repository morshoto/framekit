import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeployment } from '../scripts/validate-pages-deployment.mjs';

const sha = 'a'.repeat(40);
const run = { conclusion: 'success', headSha: sha, url: 'https://github.com/morshoto/framekit/actions/runs/123' };
const deployment = { sha, id: 1 };
const status = { state: 'success', environment_url: 'https://morshoto.github.io/framekit', log_url: run.url };
const validate = (overrides = {}) => validateDeployment({ runId: '123', expected: sha, run, deployment, status, ...overrides });

test('returns a normalized project URL only for matching successful evidence', () => {
  assert.equal(validate().href, 'https://morshoto.github.io/framekit/');
  assert.equal(new URL('en/docs/introduction/', validate()).href, 'https://morshoto.github.io/framekit/en/docs/introduction/');
});

test('rejects failed or mismatched runs and deployments', () => {
  assert.throws(() => validate({ run: { ...run, conclusion: 'failure' } }), /BLOCKED/);
  assert.throws(() => validate({ deployment: { ...deployment, sha: 'b'.repeat(40) } }), /BLOCKED/);
  assert.throws(() => validate({ status: { ...status, state: 'pending' } }), /BLOCKED/);
  assert.throws(() => validate({ status: { ...status, log_url: `${run.url}4` } }), /BLOCKED/);
  assert.throws(() => validate({ status: { ...status, environment_url: 'http://example.com/' } }), /BLOCKED/);
});
