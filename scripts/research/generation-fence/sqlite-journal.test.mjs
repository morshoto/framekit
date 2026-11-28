import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim, inspect, initialize } from './sqlite-journal.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-synthetic-sqlite-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'journal.sqlite');
}

test('separate sqlite clients claim an operation once and preserve uncertainty on restart', async t => {
  const path = await setup(t);
  await initialize(path);
  const request = { operation: 'operation-1', target: 'target-a', digest: 'a'.repeat(64), generation: 1 };
  const results = await Promise.all([claim(path, request), claim(path, request)]);
  assert.deepEqual(results.map(item => item.status).sort(), ['claimed', 'existing']);
  assert.deepEqual(await inspect(path, request.operation), { ...request, state: 'possibly-dispatched' });
  assert.equal((await claim(path, request)).status, 'existing');
});

test('duplicate operation with different target, digest or generation fails closed', async t => {
  const path = await setup(t);
  await initialize(path);
  const request = { operation: 'operation-1', target: 'target-a', digest: 'a'.repeat(64), generation: 1 };
  assert.equal((await claim(path, request)).status, 'claimed');
  for (const change of [{ target: 'target-b' }, { digest: 'b'.repeat(64) }, { generation: 2 }]) {
    assert.equal((await claim(path, { ...request, ...change })).status, 'conflict');
  }
  assert.deepEqual(await inspect(path, request.operation), { ...request, state: 'possibly-dispatched' });
  await assert.rejects(claim(path, { ...request, target: "x'; DROP TABLE operations; --" }), /invalid/);
});

test('corrupt journal and unknown operation do not fabricate completion', async t => {
  const path = await setup(t);
  await initialize(path);
  assert.equal(await inspect(path, 'missing'), undefined);
  await writeFile(path, 'corrupt');
  await assert.rejects(inspect(path, 'missing'));
});
