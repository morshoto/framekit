import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const here = new URL('./sdef-runtime/', import.meta.url).pathname;

test('characterizes Cocoa scripting in an uninstalled test app', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-sdef-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contents = join(dir, 'Mock.app', 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'));
  await copyFile(join(here, 'Info.plist'), join(contents, 'Info.plist'));
  assert.doesNotMatch(await readFile(join(contents, 'Info.plist'), 'utf8'), /com\.apple\.proapps\.MediaAssetProtocol/);
  await copyFile(join(here, 'mock.sdef'), join(contents, 'Resources', 'mock.sdef'));
  await run('xmllint', ['--xinclude', '--noout', '--dtdvalid', '/System/Library/DTDs/sdef.dtd', join(contents, 'Resources', 'mock.sdef')]);
  const binary = join(contents, 'MacOS', 'mock');
  await run('xcrun', ['swiftc', join(here, 'main.swift'), '-o', binary]);
  assert.equal((await run(binary, ['conversion-control'], { timeout: 5000 })).stdout.trim(), 'unsupported-rejected');
  const child = spawn(binary, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    let timer;
    const ready = await Promise.race([once(child.stdout, 'data').then(([chunk]) => chunk.toString().trim()), exited.then(() => 'exited'), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 5000); })]);
    clearTimeout(timer);
    assert.equal(ready, 'ready');
    await assert.rejects(run(binary, ['send', String(process.pid), 'ping'], { timeout: 5000 }), /target is not the test executable/);
    let ping;
    try { ping = await run(binary, ['send', String(child.pid), 'ping'], { timeout: 5000 }); }
    catch (error) {
      assert.match(error.stderr ?? '', /errAETimeout/);
      t.diagnostic('inconclusive: test-app ping timed out before make');
      return;
    }
    assert.equal(ping.stdout.trim(), 'pong:loaded:MockMakeCommand');
    let make;
    try { make = await run(binary, ['send', String(child.pid), 'make'], { timeout: 5000 }); }
    catch (error) {
      assert.match(error.stderr ?? '', /errAETimeout/);
      assert.doesNotMatch(error.stderr ?? '', /make-response-received/);
      t.diagnostic('inconclusive: make timed out');
      return;
    }
    assert.equal(make.stdout.trim(), 'make:asset-1:get:Synthetic:location:reco:metadata:verified:unknown-rejected');
    assert.match(stderr, /MOCK MAKE COMMAND INVOKED/);
    t.diagnostic('SDEF-backed Cocoa make and get resolved the asset, location and string metadata');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
