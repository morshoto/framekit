import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import nock from 'nock';
import { setupLabels } from '@azu/github-label-setup';

test('a later reconciliation repairs a failed label creation without duplicate writes', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'framekit-label-recovery-'));
 const labelsPath = join(directory, 'labels.json');
 const desired = { name: 'Status: Pending', color: '123456', description: 'fixture' };
 await writeFile(labelsPath, JSON.stringify([desired]));
 let remote = [];
 let creates = 0;
 nock.disableNetConnect();
 try {
  nock('https://api.github.com').persist().get('/repos/acme/framekit/labels').query(true).reply(200, () => remote);
  nock('https://api.github.com').persist().post('/repos/acme/framekit/labels').reply((_uri, body) => {
   creates++;
   if (creates === 1) return [503, { message: 'fixture unavailable' }];
   remote = [...remote, body];
   return [201, body];
  });
  const options = { token: 'fixture', repo: 'acme/framekit', labels: labelsPath };
  await assert.rejects(setupLabels(options));
  assert.deepEqual(remote, []);
  await setupLabels(options);
  assert.deepEqual(remote, [desired]);
  await setupLabels(options);
  assert.equal(creates, 2);
 } finally {
  nock.cleanAll();
  nock.enableNetConnect();
  await rm(directory, { recursive: true, force: true });
 }
});
