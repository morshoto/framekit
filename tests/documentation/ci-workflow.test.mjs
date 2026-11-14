import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { requiredJobs, docsJobs } from '../../scripts/ci/check-results.mjs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const jobs = '\n' + workflow.split('\njobs:\n')[1];
function job(id) {
  return jobs.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] ?? '';
}

test('aggregate always checks every job without serializing lint and tests', () => {
  const gate = job('ci-passed');
  assert.match(gate, /name: CI passed/);
  assert.match(gate, /if:.*always\(\)/);
  for (const id of [...requiredJobs, ...docsJobs]) assert.match(gate, new RegExp(`\\b${id}\\b`));
  assert.match(gate, /CI_JOB_RESULTS:.*toJSON\(needs\)/);
  assert.match(gate, /node scripts\/ci\/check-results.mjs/);
  for (const id of ['lint', 'test']) assert.doesNotMatch(job(id), /\n    needs:/);
});

test('the existing required test context runs the full deterministic inventory before merge', () => {
  assert.match(job('test'), /name: Unit \/ integration tests/);
  assert.match(job('test'), /validation-level: deterministic/);
  const action = readFileSync('.github/action/test/action.yml', 'utf8');
  assert.match(action, /inputs.validation-level != 'fast'[\s\S]*run: pnpm run test\s*$/m);
  assert.match(action, /inputs.validation-level == 'full'[\s\S]*pnpm run evaluate/);
});

test('Docs checks run once and both export profiles remain covered', () => {
  const foundation = job('docs-foundation');
  const exports = job('docs-export');
  assert.doesNotMatch(foundation, /matrix:/);
  assert.match(foundation, /@framekit\/docs typecheck/);
  assert.match(foundation, /@framekit\/docs test\s*$/m);
  assert.doesNotMatch(exports, /@framekit\/docs typecheck|@framekit\/docs test\s*$/m);
  assert.match(exports, /profile: root/);
  assert.match(exports, /profile: project/);
  assert.match(exports, /base_path: \/framekit/);
  for (const text of [foundation, exports]) {
    assert.match(text, /needs: docs-changes/);
    assert.match(text, /needs.docs-changes.result != 'success'/);
    assert.match(text, /needs.docs-changes.outputs.changed != 'false'/);
  }
});

test('all jobs are bounded and manual runs cannot collide with PR runs', () => {
  const ids = [...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]).filter(id => job(id));
  assert.ok(ids.length >= 9);
  for (const id of ids) assert.match(job(id), /timeout-minutes: [1-9]\d*/, id);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group:.*github.event_name.*github.event.pull_request.number.*github.run_id/);
  assert.match(job('docs-changes'), /github.event_name/);
});

test('dependency setup is shared and workflow syntax is checked', () => {
  for (const id of ['lint-static', 'test', 'consumer-runtime']) {
    const action = readFileSync(`.github/action/${id}/action.yml`, 'utf8');
    assert.match(action, /uses: \.\/\.github\/action\/setup/);
    assert.doesNotMatch(action, /uses: pnpm\/action-setup@/);
  }
  for (const id of ['docs-foundation', 'docs-export']) assert.match(job(id), /uses: \.\/\.github\/action\/setup/);
  const setup = readFileSync('.github/action/setup/action.yml', 'utf8');
  assert.match(setup, /pnpm\/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115/);
  assert.match(setup, /pnpm install --frozen-lockfile/);
  assert.match(setup, /GITHUB_STEP_SUMMARY/);
  assert.match(readFileSync('.github/action/lint-static/action.yml', 'utf8'), /pnpm run check:workflows/);
});
