import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRequestPolicy } from './github-request-policy.mjs';

test('retries transient read failures with bounded injected timing', async () => {
 let calls = 0;
 const delays = [];
 const request = createGitHubRequestPolicy({ fetchImpl: async () => ++calls === 1 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}'), sleep: async (ms) => delays.push(ms), random: () => 0, log: () => {} });
 assert.deepEqual(await request('https://api.github.com/test', {}, { readOnly: true }), { ok: true });
 assert.equal(calls, 2);
 assert.deepEqual(delays, [500]);
});

test('never replays an uncertain write', async () => {
 let calls = 0;
 const request = createGitHubRequestPolicy({ fetchImpl: async () => { calls++; throw new Error('secret'); }, sleep: async () => {}, log: () => {} });
 await assert.rejects(request('https://api.github.com/test', { method: 'POST' }), /network/);
 assert.equal(calls, 1);
});

test('respects rate limit guidance and refuses delays beyond budget', async () => {
 let calls = 0;
 const delays = [];
 let clock = 1000;
 const request = createGitHubRequestPolicy({ now: () => clock, budgetMs: 10000, random: () => 0, sleep: async (ms) => { delays.push(ms); clock += ms; }, log: () => {}, fetchImpl: async () => ++calls === 1 ? new Response('{"message":"rate limit"}', { status: 403, headers: { 'Retry-After': '3' } }) : new Response('{}') });
 await request('https://api.github.com/test', {}, { readOnly: true });
 assert.deepEqual(delays, [3000]);
 let attempts = 0;
 const deferred = createGitHubRequestPolicy({ now: () => 0, budgetMs: 1000, sleep: async () => assert.fail('must not sleep'), log: () => {}, fetchImpl: async () => { attempts++; return new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }); } });
 await assert.rejects(deferred('https://api.github.com/test', {}, { readOnly: true }), /exhausted-or-deferred/);
 assert.equal(attempts, 1);
});

test('does not retry permanent errors or leak server messages', async () => {
 for (const status of [401, 403]) {
  let calls = 0;
  const logs = [];
  const request = createGitHubRequestPolicy({ fetchImpl: async () => { calls++; return new Response('{"message":"secret-token"}', { status }); }, log: (message) => logs.push(message), sleep: async () => assert.fail('must not sleep') });
  await assert.rejects(request('https://api.github.com/test', {}, { readOnly: true }), (error) => !error.message.includes('secret-token'));
  assert.equal(calls, 1);
  assert.ok(!logs.join().includes('secret-token'));
 }
});

test('retries GitHub GraphQL rate limit errors on HTTP 200', async () => {
 let calls = 0;
 const request = createGitHubRequestPolicy({ fetchImpl: async () => ++calls === 1 ? new Response('{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}') : new Response('{"data":{"ok":true}}'), sleep: async () => {}, random: () => 0, log: () => {} });
 assert.deepEqual(await request('https://api.github.com/graphql', {}, { graphql: true, readOnly: true }), { ok: true });
 assert.equal(calls, 2);
});

test('deadline aborts an in-flight read without retrying', async () => {
 let calls = 0;
 let signal;
 const request = createGitHubRequestPolicy({ budgetMs: 30, log: () => {}, fetchImpl: async (_url, options) => {
  calls++;
  signal = options.signal;
  return new Promise(() => {});
 } });
 await assert.rejects(request('https://api.github.com/test', {}, { readOnly: true }), /deadline/);
 assert.equal(calls, 1);
 assert.equal(signal.aborted, true);
});

test('deadline also bounds reading the response body', async () => {
 const request = createGitHubRequestPolicy({ budgetMs: 30, log: () => {}, fetchImpl: async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }) });
 await assert.rejects(request('https://api.github.com/test', {}, { readOnly: true }), /deadline/);
});
