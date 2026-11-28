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

test('test-owned receiver rejects a real interprocess Open Document event', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-share-ipc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'share-ipc');
  await run('xcrun', ['swiftc', join(here, 'SwiftReceiver.swift'), join(here, 'ipc/main.swift'), '-o', binary]);
  const child = spawn(binary, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const ready = once(child.stdout, 'data').then(([chunk]) => chunk.toString().trim());
    const marker = await Promise.race([ready, exited.then(() => 'exited'), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
    assert.equal(marker, 'ready');
    assert.equal(child.exitCode, null);
    const sent = await run(binary, ['send', String(child.pid)], { timeout: 5000 });
    assert.equal(sent.stdout.trim(), 'rejected:-1708');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
