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
