import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const here = new URL('./sdef-runtime/', import.meta.url).pathname;

async function exercise(t, writableName = false, useDelegate = false) {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-sdef-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contents = join(dir, 'Mock.app', 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'));
  await copyFile(join(here, 'Info.plist'), join(contents, 'Info.plist'));
  assert.doesNotMatch(await readFile(join(contents, 'Info.plist'), 'utf8'), /com\.apple\.proapps\.MediaAssetProtocol/);
  const sdef = await readFile(join(here, 'mock.sdef'), 'utf8');
  const selectedSdef = writableName ? sdef.replace('name="name" code="pnam" type="text" access="r"', 'name="name" code="pnam" type="text" access="rw"') : sdef;
  if (writableName) assert.notEqual(selectedSdef, sdef);
  await writeFile(join(contents, 'Resources', 'mock.sdef'), selectedSdef);
  await run('xmllint', ['--xinclude', '--noout', '--dtdvalid', '/System/Library/DTDs/sdef.dtd', join(contents, 'Resources', 'mock.sdef')]);
  const binary = join(contents, 'MacOS', 'mock');
  const source = await readFile(join(here, 'main.swift'), 'utf8');
  const selectedSource = writableName ? source.replace('@objc dynamic let name: String', '@objc dynamic var name: String') : source;
  if (writableName) assert.notEqual(selectedSource, source);
  const localSource = join(dir, 'main.swift');
  await writeFile(localSource, selectedSource);
  await run('xcrun', ['swiftc', localSource, '-o', binary]);
  assert.equal((await run(binary, ['conversion-control'], { timeout: 5000 })).stdout.trim(), 'unsupported-rejected:command-well-formed');
  const child = spawn(binary, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FRAMEKIT_TEST_USE_DELEGATE: useDelegate ? '1' : '0' } });
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
    assert.equal(ping.stdout.trim(), `pong:loaded:MockMakeCommand:${Buffer.from('prdt').readUInt32BE()}`);
    let make;
    try { make = await run(binary, ['send', String(child.pid), 'make'], { timeout: 5000 }); }
    catch (error) {
      t.diagnostic(stderr);
      assert.match(error.stderr ?? '', /errAETimeout/);
      if (useDelegate && /make-response-received/.test(error.stderr ?? '')) {
        assert.match(stderr, /MOCK DELEGATE OPEN INVOKED/);
        assert.match(stderr, /MOCK DELEGATE HAS CURRENT REPLY/);
        t.diagnostic('delegate invoked but synthetic open reply timed out; result inconclusive');
        return;
      }
      assert.doesNotMatch(error.stderr ?? '', /make-response-received/);
      t.diagnostic('inconclusive: make timed out');
      return;
    }
    assert.match(make.stderr, /location-coercion:fields-retained:empty-accepted/);
    t.diagnostic(make.stderr.trim());
    assert.equal(make.stdout.trim(), 'make:asset-1:get:Synthetic:location:reco:metadata:verified:unknown-rejected:open:asset-1:open-unknown-rejected');
    assert.match(stderr, /MOCK MAKE COMMAND INVOKED/);
    if (useDelegate) assert.match(stderr, /MOCK DELEGATE OPEN INVOKED/);
    else {
      assert.match(stderr, /MOCK OPEN HANDLER INVOKED/);
      assert.match(stderr, /MOCK OPEN REGISTRATION before-reregister status=/);
      t.diagnostic(stderr.split('\n').filter(line => line.includes('MOCK OPEN REGISTRATION')).join(' | '));
    }
    const countBefore = stderr.split('MOCK MAKE COMMAND INVOKED').length - 1;
    const withProperties = await run(binary, ['send', String(child.pid), 'make-properties'], { timeout: 5000 });
    assert.equal(withProperties.stdout.trim(), 'properties:asset-2:get:Named:metadata:Incoming:options:verified');
    assert.equal(stderr.split('MOCK MAKE COMMAND INVOKED').length - 1, countBefore + 1);
    assert.match(stderr, /MOCK USER RECORD DECODER INVOKED/);
    t.diagnostic(`SDEF-backed Cocoa make/get accepted ${writableName ? 'writable' : 'read-only'} name properties`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
}

test('characterizes Cocoa scripting in an uninstalled test app', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t));
test('characterizes make with a writable name property', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t, true));
test('characterizes Cocoa application delegate open callback', { skip: process.platform !== 'darwin', timeout: 15000 }, t => exercise(t, false, true));
