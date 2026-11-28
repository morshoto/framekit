import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startSender } from './harness.mjs';
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


test('claimed operation remains uncertain after its owning process is killed', async t => {
  const path = await setup(t);
  await initialize(path);
  const request = { operation: 'operation-crash', target: 'target-a', digest: 'a'.repeat(64), generation: 1 };
  const child = fork(new URL('./sqlite-claim-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const received = once(child, 'message');
  const exited = once(child, 'exit');
  child.send({ path, request });
  const outcome = await Promise.race([received.then(([value]) => value), exited.then(() => 'child-exited')]);
  assert.equal(outcome, 'claimed');
  assert.equal(child.kill('SIGKILL'), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(await inspect(path, request.operation), { ...request, state: 'possibly-dispatched' });
  assert.equal((await claim(path, request)).status, 'existing');
});


test('prior claim is reported while downstream queued work still executes', async t => {
  const path = await setup(t);
  const directory = dirname(path);
  const output = join(directory, 'output');
  const trigger = join(directory, 'trigger');
  const sentinel = join(directory, 'unrelated');
  const request = { operation: 'operation-queued', target: 'target-a', digest: 'a'.repeat(64), generation: 1 };
  await writeFile(sentinel, 'untouched');
  await initialize(path);
  assert.equal((await claim(path, request)).status, 'claimed');
  const sender = await startSender({ output, trigger });
  await sender.dispatch();
  await sender.kill();
  assert.equal((await claim(path, request)).status, 'existing');
  assert.equal((await inspect(path, request.operation)).state, 'possibly-dispatched');
  await writeFile(trigger, 'continue');
  let actual;
  for (let i = 0; i < 100; i++) {
    try { actual = await readFile(output, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(actual, 'delayed receiver executed\n');
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  assert.equal((await inspect(path, request.operation)).state, 'possibly-dispatched');
});


test('an uncommitted claim can disappear while queued work still executes', async t => {
  const path = await setup(t);
  const directory = dirname(path);
  const output = join(directory, 'output');
  const trigger = join(directory, 'trigger');
  const sentinel = join(directory, 'unrelated');
  const request = { operation: 'operation-uncommitted', target: 'target-a', digest: 'a'.repeat(64), generation: 1 };
  await writeFile(sentinel, 'untouched');
  await initialize(path);
  const writer = spawn('python3', [new URL('./sqlite-uncommitted.py', import.meta.url).pathname, path], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(writer, 'exit');
  try {
    const ready = once(writer.stdout, 'data').then(([data]) => data.toString().trim());
    assert.equal(await Promise.race([ready, exited.then(() => 'child-exited')]), 'ready');
    assert.equal(await inspect(path, request.operation), undefined);
    const sender = await startSender({ output, trigger });
    await sender.dispatch();
    await sender.kill();
    assert.equal(writer.kill('SIGKILL'), true);
    assert.equal((await exited)[1], 'SIGKILL');
    assert.equal(await inspect(path, request.operation), undefined);
    assert.equal((await claim(path, request)).status, 'claimed');
    await writeFile(trigger, 'continue');
    let actual;
    for (let i = 0; i < 100; i++) {
      try { actual = await readFile(output, 'utf8'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(actual, 'delayed receiver executed\n');
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    await exited;
  }
});
