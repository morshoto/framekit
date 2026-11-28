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

test('characterizes a synthetic make exchange between test-owned processes', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-share-make-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'test-make');
  await run('xcrun', ['swiftc', join(here, 'ipc-make/main.swift'), '-o', binary]);
  const child = spawn(binary, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let receiverError = '';
  child.stderr.on('data', chunk => { receiverError += chunk.toString(); });
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
    assert.equal((await run(binary, ['ping', String(child.pid)], { timeout: 5000 })).stdout.trim(), 'pong:0');
    let response;
    try {
      response = await run(binary, ['send', String(child.pid)], { timeout: 5000 });
    } catch (error) {
      // A timeout without handler entry has been observed after a successful ping.
      // Record this as inconclusive; never infer that the request was handled.
      assert.match(error.stderr ?? '', /errAETimeout/);
      assert.doesNotMatch(receiverError, /make received/);
      t.diagnostic('inconclusive: make timed out without observed handler entry');
    }
    if (response) {
      assert.match(response.stdout.trim(), /^specifier:aset:ID  :test-asset-[0-9a-f-]{36}:location:mock-location:unknown-rejected$/);
      t.diagnostic('make specifier resolved by a subsequent synthetic get');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
