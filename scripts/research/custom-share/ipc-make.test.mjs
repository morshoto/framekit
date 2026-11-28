import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = new URL('./', import.meta.url).pathname;

test('test-owned processes exchange a synthetic make specifier', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-share-make-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'test-make');
  await run('xcrun', ['swiftc', join(here, 'ipc-make/main.swift'), '-o', binary]);
  const child = spawn(binary, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    let timer;
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => chunk.toString().trim()),
      exited.then(() => 'exited'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 5000); }),
    ]);
    clearTimeout(timer);
    assert.equal(ready, 'ready');
    await assert.rejects(run(binary, ['send', String(process.pid)], { timeout: 5000 }), /target is not the test executable/);
    const reply = await run(binary, ['send', String(child.pid)], { timeout: 5000 });
    assert.equal(reply.stdout.trim(), 'specifier:aset:ID  :test-asset-0');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
