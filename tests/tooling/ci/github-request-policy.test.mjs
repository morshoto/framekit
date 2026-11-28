import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRequestPolicy, isReadOnlyGraphQL } from '../../../scripts/github-request-policy.mjs';

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

test('recovers from transient server, network, and GraphQL execution failures', async () => {
 for (const first of [
  () => new Response('{}', { status: 502 }),
  () => new Response('{}', { status: 503 }),
  () => new Response('{}', { status: 504 }),
  () => { throw new Error('offline'); },
  () => new Response('{"errors":[{"message":"Internal execution error"}]}'),
  () => new Response('{"errors":[{"message":"internal error"}]}', { status: 502 }),
 ]) {
  let calls = 0;
  const request = createGitHubRequestPolicy({ fetchImpl: async () => ++calls === 1 ? first() : new Response('{"data":{"ok":true}}'), sleep: async () => {}, random: () => 0, log: () => {} });
  assert.deepEqual(await request('https://api.github.com/graphql', {}, { graphql: true, readOnly: true }), { ok: true });
  assert.equal(calls, 2);
 }
});

test('secondary and primary rate limits honor guidance and stop at attempt limit', async () => {
 for (const [status, headers, body, expected] of [
  [403, { 'retry-after': '3' }, '{"message":"secondary rate limit"}', 3000],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' }, '{}', 4000],
  [429, { 'retry-after': '2' }, '{}', 2000],
 ]) {
  let calls = 0, clock = 1000;
  const delays = [];
  const request = createGitHubRequestPolicy({ fetchImpl: async () => { calls++; return new Response(body, { status, headers }); }, now: () => clock, random: () => 0, sleep: async (ms) => { delays.push(ms); clock += ms; }, log: () => {}, maxAttempts: 2 });
  await assert.rejects(request('https://api.github.com/test', {}, { readOnly: true }), /exhausted-or-deferred/);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [expected]);
 }
});

test('only explicit GraphQL queries are marked safe to retry', () => {
 assert.equal(isReadOnlyGraphQL('  query Fetch { viewer { id } }'), true);
 assert.equal(isReadOnlyGraphQL('mutation Change { update { id } }'), false);
 assert.equal(isReadOnlyGraphQL('{ viewer { id } }'), false);
});

test('rejects malformed successful JSON rather than treating a write as successful', async () => {
 const request = createGitHubRequestPolicy({ log: () => {}, fetchImpl: async () => new Response('not-json', { status: 200 }) });
 await assert.rejects(request('https://api.github.com/test', { method: 'POST' }), /invalid-response/);
});

test('reports partial label changes and refreshes issue state after an uncertain write', async () => {
 const { createProjectStatusClient } = await import('../../../scripts/sync-project-status.mjs');
 const calls = [];
 const client = createProjectStatusClient({ repository: 'owner/repo', token: 'secret', fetchImpl: async (url, options) => {
  calls.push([options.method, new URL(url).pathname]);
  if (options.method === 'POST') throw new Error('connection lost after write');
  return new Response(JSON.stringify({ number: 42, state: 'open', labels: [{ name: 'Status: Pending' }] }));
 } });
 await assert.rejects(client.setIssueStatusLabel({ number: 42, labels: [] }, 'Pending'), /PARTIAL_STATUS_SYNC.*desired/);
 assert.deepEqual(calls.map(([method]) => method), ['POST', 'GET']);
});

test('reports the observed project state after an uncertain status mutation without replay', async () => {
 const { createProjectStatusClient, PROJECT_STATUSES } = await import('../../../scripts/sync-project-status.mjs');
 const options = PROJECT_STATUSES.map((name) => ({ name, id: `option-${name}` }));
 for (const [observed, itemStatus] of [['desired', 'Pending'], ['different', 'In review'], ['missing', null]]) {
  const operations = [];
  const client = createProjectStatusClient({ repository: 'owner/repo', token: 'secret', fetchImpl: async (_url, init) => {
   const { query } = JSON.parse(init.body);
   operations.push(query.trim().match(/^(query|mutation)\b/)[1]);
   if (query.includes('updateProjectV2ItemFieldValue')) throw new Error('connection lost after mutation');
   const items = itemStatus === null ? [] : [{ id: 'item', fieldValues: { nodes: [{ name: itemStatus, field: { id: 'field' } }] } }];
   return new Response(JSON.stringify({ data: { user: { projectV2: { id: 'project', fields: { nodes: [{ id: 'field', name: 'Status', options }] }, items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
  } });
  const project = { id: 'project', statusField: { id: 'field' }, options: new Map(options.map((option) => [option.name, option.id])) };
  await assert.rejects(client.setProjectStatus(project, 'item', 'Pending', 'In progress'), new RegExp(`PARTIAL_STATUS_SYNC.*project.*observation=${observed}`));
  assert.deepEqual(operations, ['mutation', 'query']);
 }
});

test('reports unavailable observation when refreshing an uncertain project mutation fails', async () => {
 const { createProjectStatusClient } = await import('../../../scripts/sync-project-status.mjs');
 let calls = 0;
 const client = createProjectStatusClient({ repository: 'owner/repo', token: 'secret', fetchImpl: async () => {
  calls++;
  return new Response('{}', { status: 401 });
 } });
 const project = { id: 'project', statusField: { id: 'field' }, options: new Map([['Pending', 'option']]) };
 await assert.rejects(client.setProjectStatus(project, 'item', 'Pending', 'In progress'), /PARTIAL_STATUS_SYNC.*observation=unavailable/);
 assert.equal(calls, 2);
});
