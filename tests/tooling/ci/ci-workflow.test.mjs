import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import { requiredJobs, docsJobs } from '../../../scripts/ci/check-results.mjs';

const config = file => load(readFileSync(file, 'utf8'));
const workflow = config('.github/workflows/ci.yml');
const jobs = workflow.jobs;
const action = name => config(`.github/action/${name}/action.yml`).runs.steps;
const command = (steps, run) => steps.find(step => step.run === run);
const uses = (steps, name) => steps.some(step => step.uses?.startsWith(name));

test('aggregate always checks every job without serializing lint and tests', () => {
  const gate = jobs['ci-passed'];
  assert.equal(gate.name, 'CI passed');
  assert.ok(gate.if.includes('always()'));
  for (const id of [...requiredJobs, ...docsJobs]) assert.ok(gate.needs.includes(id));
  const check = command(gate.steps, 'node scripts/ci/check-results.mjs');
  assert.ok(check.env.CI_JOB_RESULTS.includes('toJSON(needs)'));
  for (const id of ['lint', 'test']) assert.equal(jobs[id].needs, undefined);
});

test('the existing required test context runs the full deterministic inventory before merge', () => {
  assert.equal(jobs.test.name, 'Unit / integration tests');
  const invocation = jobs.test.steps.find(step => step.uses === './.github/action/test');
  assert.equal(invocation.with['validation-level'], 'deterministic');
  assert.equal(command(action('test'), 'pnpm run test').if, "${{ inputs.validation-level != 'fast' }}");
  assert.equal(command(action('test'), 'pnpm run evaluate').if, "${{ inputs.validation-level == 'full' }}");
});

test('Docs checks run once and both export profiles remain covered', () => {
  const foundation = jobs['docs-foundation'], exports = jobs['docs-export'];
  assert.equal(foundation.strategy, undefined);
  assert.ok(command(foundation.steps, 'pnpm --filter @framekit/docs typecheck'));
  assert.equal(foundation.steps.filter(step => step.run?.startsWith('pnpm --filter @framekit/docs test ')).length, 1);
  assert.equal(exports.steps.some(step => /@framekit\/docs (typecheck|test )/.test(step.run ?? '')), false);
  assert.deepEqual(exports.strategy.matrix.include, [{ profile: 'root', base_path: '' }, { profile: 'project', base_path: '/framekit' }]);
  for (const job of [foundation, exports]) {
    assert.equal(job.needs, 'docs-changes');
    assert.ok(job.if.includes("needs.docs-changes.result != 'success'"));
    assert.ok(job.if.includes("needs.docs-changes.outputs.changed != 'false'"));
  }
});

test('all jobs are bounded and manual runs cannot collide with PR runs', () => {
  assert.ok(Object.keys(jobs).length >= 9);
  for (const [id, job] of Object.entries(jobs)) assert.ok(job['timeout-minutes'] > 0, id);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  for (const expression of ['github.event_name', 'github.event.pull_request.number', 'github.run_id']) assert.ok(workflow.concurrency.group.includes(expression));
  assert.ok(jobs['docs-changes'].steps.some(step => step.env?.EVENT_NAME?.includes('github.event_name')));
});

test('dependency setup is shared and workflow syntax is checked', () => {
  for (const id of ['lint-static', 'test', 'consumer-runtime']) {
    assert.ok(uses(action(id), './.github/action/setup'));
    assert.equal(uses(action(id), 'pnpm/action-setup@'), false);
  }
  for (const id of ['docs-foundation', 'docs-export']) assert.ok(uses(jobs[id].steps, './.github/action/setup'));
  const setup = action('setup');
  assert.ok(uses(setup, 'pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115'));
  assert.ok(command(setup, 'pnpm install --frozen-lockfile'));
  assert.ok(setup.some(step => step.run?.includes('GITHUB_STEP_SUMMARY')));
  assert.ok(command(action('lint-static'), 'pnpm run check:workflows'));
});

test('Docs and package smoke retain failure diagnostics', () => {
  const foundation = jobs['docs-foundation'].steps, exports = jobs['docs-export'].steps;
  const docsTests = foundation.find(step => step.run?.startsWith('pnpm --filter @framekit/docs test '));
  assert.ok(docsTests.run.includes('--reporter=json'));
  assert.ok(docsTests.run.includes('--reporter=junit'));
  assert.ok(foundation.some(step => step.if?.includes('always()') && step.uses?.startsWith('actions/upload-artifact@')));
  assert.ok(exports.some(step => step.if?.includes('failure()') && step.uses?.startsWith('actions/upload-artifact@')));
  for (const file of ['docs-build.log', 'docs-export.log']) assert.ok(exports.some(step => step.shell === 'bash' && step.run?.includes('tee') && step.run.includes(file)));
  const consumer = action('consumer-runtime');
  assert.ok(consumer.some(step => step.run?.includes('@modelcontextprotocol/sdk@1.32.2')), 'consumer smoke installs its own independent MCP client');
  assert.ok(consumer.some(step => step.run?.includes('tee') && step.run.includes('consumer-runtime.log')));
  assert.ok(consumer.some(step => step.if?.includes('always()') && step.uses?.startsWith('actions/upload-artifact@')));
});

test('Nix smoke validates the environment while required deterministic tests own coverage', () => {
  const runs = jobs['nix-fixture'].steps.map(step => step.run ?? '').join('\n');
  for (const run of ['pnpm install --frozen-lockfile', 'pnpm run build', 'doctor dev --profile fixture', 'pnpm run smoke:fixture-mcp']) assert.ok(runs.includes(run), run);
  assert.equal(runs.includes('pnpm run test'), false);
  assert.equal(jobs.test.name, 'Unit / integration tests');
  assert.equal(jobs.test.steps.find(step => step.uses === './.github/action/test').with['validation-level'], 'deterministic');
});

test('aggregate dependencies account for every validation job in this workflow', () => {
  assert.deepEqual(jobs['ci-passed'].needs.toSorted(), Object.keys(jobs).filter(id => id !== 'ci-passed').sort());
});

test('deterministic PR coverage reports package branches even when tests fail', () => {
  const steps = action('test');
  const tests = command(steps, 'pnpm run test');
  assert.equal(tests.id, 'deterministic-tests');
  assert.ok(tests.env.NODE_V8_COVERAGE.endsWith('/artifacts/test-results/v8'));
  const report = command(steps, 'pnpm run coverage:report');
  assert.equal(report.if, "${{ always() && inputs.validation-level != 'fast' }}");
  assert.ok(report.env.FRAMEKIT_COVERAGE_TEST_OUTCOME.includes('steps.deterministic-tests.outcome'));
});

test('milestone warnings compare releases numerically and ignore unknown milestones', async () => {
  const { futureBlockers } = await import('../../../scripts/warn-future-blockers.mjs');
  const issue = { milestone: { title: 'Release for v0.2.6' } };
  const blocker = (number, title) => ({ number, url: `https://github.com/a/b/issues/${number}`, milestone: title && { title } });
  assert.deepEqual(futureBlockers(issue, [blocker(1, 'Release for v0.2.10'), blocker(2, 'Release for v0.2.6'), blocker(3, 'Release for v0.1.99'), blocker(4, 'Other'), blocker(5, null)]).map(x => x.number), [1]);
  assert.deepEqual(futureBlockers({ milestone: null }, [blocker(1, 'Release for v0.3.0')]), []);
});

test('milestone warnings create, update, resolve and avoid duplicate comments', async () => {
  const { syncWarning } = await import('../../../scripts/warn-future-blockers.mjs');
  const issue = { number: 1, milestone: { title: 'Release for v0.2.6' } };
  const blocker = { number: 2, url: 'https://github.com/a/b/issues/2', milestone: { title: 'Release for v0.3.3' } };
  const writes = [];
  const api = { comments: [], async listComments() { return this.comments; }, async createComment(_, body) { writes.push(body); }, async updateComment(id, body) { writes.push([id, body]); } };
  await syncWarning(api, issue, [blocker]);
  assert.match(writes[0], /v0\.3\.3/);
  api.comments = [{ id: 9, user: { login: 'github-actions[bot]' }, body: writes[0] }];
  await syncWarning(api, issue, [blocker]);
  assert.equal(writes.length, 1);
  await syncWarning(api, issue, []);
  assert.match(writes[1][1], /resolved/i);
  api.comments[0].body = writes[1][1];
  await syncWarning(api, issue, []);
  assert.equal(writes.length, 2);
});

test('milestone warning reconciliation checks both sides and skips other repositories', async () => {
  const { reconcile } = await import('../../../scripts/warn-future-blockers.mjs');
  const seen = [];
  const api = {
    async issue(number) { return { number }; },
    async blocking() { return [{ number: 2, state: 'OPEN', repository: { nameWithOwner: 'a/b' } }, { number: 3, state: 'OPEN', repository: { nameWithOwner: 'c/d' } }]; },
    async blockers(number) { seen.push(number); return []; },
    async listComments() { return []; },
  };
  await reconcile(api, 'a/b', 'issues', { issue: { number: 1 } });
  assert.deepEqual(seen, [1, 2]);
});

test('milestone warning API paginates dependencies and fails on GraphQL errors', async () => {
  const { createApi } = await import('../../../scripts/warn-future-blockers.mjs');
  let count = 0;
  const api = createApi({ repository: 'a/b', token: 'token', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    count++;
    assert.equal(request.variables.cursor, count === 1 ? null : 'next');
    return new Response(JSON.stringify({ data: { repository: { issue: { blockedBy: { nodes: [{ number: count }], pageInfo: { hasNextPage: count === 1, endCursor: 'next' } } } } } }));
  } });
  assert.deepEqual((await api.blockers(1)).map(item => item.number), [1, 2]);
  const broken = createApi({ repository: 'a/b', token: 'token', fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: 'denied' }] })) });
  await assert.rejects(broken.blockers(1), /denied/);
});

test('assign workflow schedules and serializes milestone warnings', () => {
  const assign = config('.github/workflows/assign.yml');
  assert.ok(assign.on.schedule.length);
  assert.ok(assign.on.issues.types.includes('milestoned'));
  assert.ok(assign.on.issues.types.includes('demilestoned'));
  assert.equal(assign.jobs['warn-future-blockers'].permissions.issues, 'write');
  assert.equal(assign.jobs['warn-future-blockers'].concurrency['cancel-in-progress'], false);
});
