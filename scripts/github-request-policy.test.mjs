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
