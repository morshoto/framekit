import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

const readWorkflow = (name) => load(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));

test('repository label definitions reconcile on configuration changes and repair, not ordinary events', () => {
 const assign = readWorkflow('assign');
 const maintenance = readWorkflow('repository-labels');
 assert.equal(assign.jobs['sync-labels'], undefined);
 assert.equal(assign.jobs['assign-label'].needs, undefined);
 assert.deepEqual(maintenance.on.push.branches, ['main']);
 assert.deepEqual(maintenance.on.push.paths, ['.github/labels/labels.json']);
 assert.ok(Object.hasOwn(maintenance.on, 'workflow_dispatch'));
 assert.deepEqual(maintenance.on.schedule, [{ cron: '31 */6 * * *' }]);
 assert.equal(Object.hasOwn(maintenance.on, 'pull_request'), false);
 assert.equal(Object.hasOwn(maintenance.on, 'issues'), false);
 const job = maintenance.jobs.sync;
 assert.equal(job.permissions.issues, 'write');
 assert.equal(job.permissions.contents, 'read');
 assert.ok(job.steps.some((step) => step.run?.includes('github-label-setup')));
 assert.ok(job.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'] === false);
});

test('issue project sync starts only for lifecycle or status-label events and manual repair', () => {
 const condition = readWorkflow('assign').jobs['sync-project-status'].if;
 for (const action of ['opened', 'reopened', 'closed', 'milestoned', 'demilestoned', 'labeled', 'unlabeled']) assert.ok(condition.includes(`"${action}"`), action);
 for (const label of ['Status: Backlog', 'Status: In progress', 'Status: In review', 'Status: Pending', 'Status: Done']) assert.ok(condition.includes(label), label);
 assert.ok(condition.includes('github.event.label.name'));
 assert.ok(condition.includes("github.event_name == 'workflow_dispatch'"));
});

test('write-capable PR jobs run checked-out code and configuration from the default branch', () => {
 const assign = readWorkflow('assign');
 for (const name of ['assign-label', 'sync-pull-request-milestone']) {
  const checkout = assign.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}', name);
  assert.equal(checkout.with['persist-credentials'], false, name);
 }
});

test('author assignment runs only for events supported by the pinned action', () => {
 const condition = readWorkflow('assign').jobs['assign-author'].if;
 assert.match(condition, /github\.event\.action == 'opened'/);
 assert.match(condition, /github\.event\.action == 'reopened'/);
 assert.ok(condition.includes("github.event_name == 'pull_request'"));
 assert.ok(condition.includes("github.event_name == 'issues'"));
 for (const bot of ['renovate[bot]', 'dependabot[bot]']) assert.ok(condition.includes(bot));
 assert.equal(condition.includes('synchronize'), false);
 assert.equal(condition.includes('edited'), false);
});

test('workflow conditions preserve behavior across issue and PR event fixtures', async () => {
 const { Parser, Lexer, Evaluator, data } = await import('@actions/expressions');
 const workflow = readWorkflow('assign');
 const condition = (job, eventName, action, label = '', actor = 'contributor') => {
  const source = workflow.jobs[job].if.replace(/^\s*\$\{\{|\}\}\s*$/g, '').trim();
  const tokens = new Lexer(source).lex().tokens;
  const expr = new Parser(tokens, ['github'], []).parse();
  const object = (entries) => new data.Dictionary(...Object.entries(entries).map(([key, value]) => ({ key, value: typeof value === 'string' ? new data.StringData(value) : object(value) })));
  const context = object({ github: { event_name: eventName, actor, event: { action, label: { name: label } } } });
  return new Evaluator(expr, context).evaluate().coerceString() === 'true';
 };
 for (const action of ['opened', 'reopened', 'closed', 'milestoned', 'demilestoned']) assert.equal(condition('sync-project-status', 'issues', action), true, action);
 for (const action of ['labeled', 'unlabeled']) {
  for (const label of ['Status: Backlog', 'Status: In progress', 'Status: In review', 'Status: Pending', 'Status: Done']) assert.equal(condition('sync-project-status', 'issues', action, label), true, `${action} ${label}`);
  assert.equal(condition('sync-project-status', 'issues', action, 'Priority: High'), false);
 }
 assert.equal(condition('sync-project-status', 'workflow_dispatch', ''), true);
 assert.equal(condition('sync-project-status', 'pull_request', 'opened'), false);
 for (const action of ['opened', 'reopened']) assert.equal(condition('assign-author', 'pull_request', action), true);
 for (const action of ['synchronize', 'edited']) assert.equal(condition('assign-author', 'pull_request', action), false);
 assert.equal(condition('assign-author', 'pull_request', 'opened', '', 'dependabot[bot]'), false);
 assert.equal(condition('assign-author', 'pull_request', 'opened', '', 'renovate[bot]'), false);
 assert.equal(condition('assign-author', 'issues', 'opened'), true);
 assert.equal(condition('assign-author', 'issues', 'reopened'), false);
});

test('a later PR event repairs a milestone after an interrupted timeline read', async () => {
 let interrupted = true;
 let milestone = null;
 let writes = 0;
 const fetchImpl = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/issues/22') && init.method === 'PATCH') {
   writes += 1;
   milestone = JSON.parse(String(init.body)).milestone;
   return jsonResponse({ number: 22, milestone: { number: milestone } });
  }
  if (url.endsWith('/issues/22')) return jsonResponse({ number: 22, pull_request: {}, milestone: milestone === null ? null : { number: milestone } });
  if (url.endsWith('/issues/123')) return jsonResponse({ number: 123, milestone: { number: 21 } });
  if (url.includes('/timeline?')) {
   if (interrupted) throw new Error('simulated interruption');
   return jsonResponse([{ event: 'cross-referenced', source: { issue: { number: 22, pull_request: {} } } }]);
  }
  throw new Error(`Unexpected request: ${url}`);
 };
 const { syncPullRequestMilestone } = await import('../../../scripts/sync-pr-milestone.mjs');
 const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
 const options = { repository: 'acme/framekit', pullRequestNumber: 22, body: 'Refs #123', token: 'test-token', fetchImpl, timelineRetryDelaysMs: [] };
 await assert.rejects(syncPullRequestMilestone(options), /simulated interruption/);
 assert.equal(milestone, null);
 assert.equal(writes, 0);
 interrupted = false;
 assert.deepEqual(await syncPullRequestMilestone(options), { action: 'updated', milestoneNumber: 21 });
 assert.equal(milestone, 21);
 assert.equal(writes, 1);
});

test('manual milestone repair uses current PR state after a missed event', async () => {
 const { repairPullRequestMilestone } = await import('../../../scripts/sync-pr-milestone.mjs');
 const writes = [];
 const fetchImpl = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/pulls/22')) return new Response(JSON.stringify({ number: 22, state: 'open', body: 'Refs #123', head: { repo: { full_name: 'acme/framekit' } } }));
  if (url.endsWith('/issues/22') && init.method === 'PATCH') { writes.push(JSON.parse(init.body)); return new Response('{}'); }
  if (url.endsWith('/issues/22')) return new Response(JSON.stringify({ pull_request: {}, milestone: null }));
  if (url.endsWith('/issues/123')) return new Response(JSON.stringify({ milestone: { number: 21 } }));
  if (url.includes('/timeline?')) return new Response(JSON.stringify([{ event: 'cross-referenced', source: { issue: { number: 22, pull_request: {} } } }]));
  throw new Error(`unexpected ${url}`);
 };
 assert.deepEqual(await repairPullRequestMilestone({ repository: 'acme/framekit', pullRequestNumber: 22, token: 'fixture', fetchImpl }), { action: 'updated', milestoneNumber: 21 });
 assert.deepEqual(writes, [{ milestone: 21 }]);
});

test('manual milestone repair does not mutate closed, missing or fork PRs', async () => {
 const { repairPullRequestMilestone } = await import('../../../scripts/sync-pr-milestone.mjs');
 for (const pr of [null, { state: 'closed', head: { repo: { full_name: 'acme/framekit' } } }, { state: 'open', head: { repo: { full_name: 'other/fork' } } }]) {
  let calls = 0;
  const fetchImpl = async () => { calls++; return pr ? new Response(JSON.stringify(pr)) : new Response('', { status: 404 }); };
  const result = await repairPullRequestMilestone({ repository: 'acme/framekit', pullRequestNumber: 22, token: 'fixture', fetchImpl });
  assert.equal(result.action, 'skip');
  assert.equal(calls, 1);
 }
});

test('manual repair dispatch targets a PR without starting project backfill', async () => {
 const { Parser, Lexer, Evaluator, data } = await import('@actions/expressions');
 const workflow = readWorkflow('assign');
 assert.equal(workflow.on.workflow_dispatch.inputs.pr_number.required, false);
 const evaluate = (job, prNumber) => {
  const source = workflow.jobs[job].if.replace(/^\s*\$\{\{|\}\}\s*$/g, '').trim();
  const node = new Parser(new Lexer(source).lex().tokens, ['github'], []).parse();
  const dict = (obj) => new data.Dictionary(...Object.entries(obj).map(([key, value]) => ({ key, value: typeof value === 'string' ? new data.StringData(value) : dict(value) })));
  return new Evaluator(node, dict({ github: { event_name: 'workflow_dispatch', event: { inputs: { pr_number: prNumber }, pull_request: { head: { repo: { full_name: '' } } } }, repository: 'acme/framekit' } })).evaluate().coerceString() === 'true';
 };
 assert.equal(evaluate('sync-pull-request-milestone', '22'), true);
 assert.equal(evaluate('sync-project-status', '22'), false);
 assert.equal(evaluate('warn-future-blockers', '22'), false);
 assert.equal(evaluate('sync-pull-request-milestone', ''), false);
 assert.equal(evaluate('sync-project-status', ''), true);
 assert.equal(evaluate('warn-future-blockers', ''), true);
});
