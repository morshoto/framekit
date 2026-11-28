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
 assert.ok(maintenance.on.schedule.length > 0);
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
  const object = (entries) => new data.Dictionary(Object.entries(entries).map(([key, value]) => ({ key, value: typeof value === 'string' ? new data.StringData(value) : object(value) })));
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
