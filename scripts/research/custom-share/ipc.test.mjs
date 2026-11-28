import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = new URL('./', import.meta.url).pathname;

async function exercise(t, errorCode, useFile = false) {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-share-ipc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'share-ipc');
  await run('xcrun', ['swiftc', join(here, 'SwiftReceiver.swift'), join(here, 'ipc/main.swift'), '-o', binary]);
  const control = errorCode === -1701 ? ['-1701'] : [];
  if (useFile) await Promise.all([0, 1, 2].map(i => writeFile(join(dir, `mock-${i}.fcpxml`), '<fcpxml/>')));
  const sendArgs = (pid, id) => useFile ? ['send-file', String(pid), `mock-${id}`, join(dir, `mock-${id}.fcpxml`)] : ['send', String(pid), `mock-${id}`, ...control];
  const child = spawn(binary, ['listen', ...control], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    await assert.rejects(run(binary, sendArgs(process.pid, 0), { timeout: 5000 }), /target is not the test executable/);
    const responses = await Promise.all(Array.from({ length: 3 }, (_, i) => run(binary, sendArgs(child.pid, i), { timeout: 5000 })));
    assert.deepEqual(responses.map(response => response.stdout.trim()), Array(3).fill(`rejected:${errorCode}`));
    if (useFile) for (const i of [0, 1, 2]) assert.equal(await readFile(join(dir, `mock-${i}.fcpxml`), 'utf8'), '<fcpxml/>');
    for (let i = 0; i < 100 && ![0, 1, 2].every(id => output.includes(`handled:mock-${id}:`)); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const id of [0, 1, 2]) {
      const observations = output.split('\n').filter(line => line.startsWith(`handled:mock-${id}:`));
      assert.ok(observations.length >= 1, `missing handler observation for mock-${id}`);
      t.diagnostic(`mock-${id} handler observations: ${observations.join(', ')}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}

test('test-owned receiver rejects a real interprocess Open Document event', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t, -1708));
test('control error is returned by the test-owned receiver', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t, -1701));

test('file URL descriptors are rejected without consuming files', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t, -1708, true));
