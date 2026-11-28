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
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    const ready = once(child.stdout, 'data').then(([chunk]) => chunk.toString().split('\n')[0]);
    let readyTimer;
    let marker;
    try { marker = await Promise.race([ready, exited.then(() => 'exited'), new Promise(resolve => { readyTimer = setTimeout(() => resolve('timeout'), 5000); })]); }
    finally { clearTimeout(readyTimer); }
    assert.equal(marker, 'ready');
    assert.equal(child.exitCode, null);
    await assert.rejects(run(binary, ['send', String(process.pid), 'mock-0'], { timeout: 5000 }), /target is not the test executable/);
    const responses = await Promise.all(Array.from({ length: 3 }, (_, i) => run(binary, ['send', String(child.pid), `mock-${i}`], { timeout: 5000 })));
    assert.deepEqual(responses.map(response => response.stdout.trim()), Array(3).fill('rejected:-1708'));
    for (let i = 0; i < 100 && ![0, 1, 2].every(id => output.includes(`handled:mock-${id}:`)); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const id of [0, 1, 2]) {
      const observations = output.split('\n').filter(line => line.startsWith(`handled:mock-${id}:`));
      const count = observations.length;
      assert.ok(count >= 1, `missing handler observation for mock-${id}`);
      t.diagnostic(`mock-${id} handler observations: ${observations.join(', ')}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
