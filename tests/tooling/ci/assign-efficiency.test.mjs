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
