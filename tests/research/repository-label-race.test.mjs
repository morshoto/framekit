// Opt-in counterexample, excluded from the repository's deterministic suite.
// In an isolated disposable directory, install exactly:
// npm install --prefix "$LABEL_SYNC_TEST_ROOT" --ignore-scripts --no-save @azu/github-label-setup@5.2.0 nock@14.0.17
// Then run: node --test tests/research/repository-label-race.test.mjs
// All requests are intercepted; the token and repository below are fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.LABEL_SYNC_TEST_ROOT;
if (!root) throw new Error('LABEL_SYNC_TEST_ROOT_REQUIRED');
const require = createRequire(join(root, 'package.json'));
assert.equal(require('@azu/github-label-setup/package.json').version, '5.2.0');
assert.equal(require('nock/package.json').version, '14.0.17');
const upstreamRequire = createRequire(require.resolve('@azu/github-label-setup'));
assert.equal(upstreamRequire('github-label-sync/package.json').version, '2.3.1');
const nock = require('nock');
const { setupLabels } = await import(pathToFileURL(require.resolve('@azu/github-label-setup')).href);
const desired = { name: 'Status: Pending', color: '123456', description: 'fixture' };

async function fixture(run) {
 const dir = await mkdtemp(join(tmpdir(), 'framekit-label-race-'));
 const labels = join(dir, 'labels.json');
 await writeFile(labels, JSON.stringify([desired]));
 nock.disableNetConnect();
 try { await run({ labels, token: 'fixture', repo: 'acme/framekit' }); }
 finally { nock.cleanAll(); nock.enableNetConnect(); await rm(dir, { recursive: true, force: true }); }
}

test('counterexample: a concurrent edit can be overwritten by an unconditional label update', async () => {
 await fixture(async (options) => {
  let remote = { ...desired, color: '111111' };
  let ifMatch;
  nock('https://api.github.com').get('/repos/acme/framekit/labels').query(true).reply(() => {
   const snapshot = { ...remote };
   remote = { ...remote, color: 'abcdef' }; // A different writer acts after the read.
   return [200, [snapshot]];
  });
  nock('https://api.github.com').patch('/repos/acme/framekit/labels/Status%3A%20Pending').reply(function (_path, body) {
   ifMatch = this.req.headers['if-match'];
   remote = { ...remote, ...body, name: body.new_name ?? remote.name };
   delete remote.new_name;
   return [200, remote];
  });
  await setupLabels(options);
  assert.equal(ifMatch, undefined);
  assert.equal(remote.color, desired.color); // The concurrent abcdef change was lost.
 });
});

test('a later reconciliation observes an applied creation after its acknowledgement is lost', async () => {
 await fixture(async (options) => {
  let remote = [];
  let creates = 0;
  nock('https://api.github.com').persist().get('/repos/acme/framekit/labels').query(true).reply(200, () => remote);
  nock('https://api.github.com').persist().post('/repos/acme/framekit/labels').reply((_path, body) => {
   creates++;
   remote = [...remote, body];
   return [503, { message: 'acknowledgement lost' }];
  });
  await assert.rejects(setupLabels(options));
  await setupLabels(options);
  assert.equal(creates, 1);
  assert.deepEqual(remote, [desired]);
 });
});
