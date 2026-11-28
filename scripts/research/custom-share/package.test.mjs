import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = new URL('./swift-app/', import.meta.url).pathname;

test('research bundle describes a fail-closed scripting endpoint', { skip: process.platform !== 'darwin' }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'framekit-share-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const plist = join(root, 'Info.plist');
  const sdef = join(root, 'ShareResearch.sdef');
  await run('plutil', ['-lint', plist]);
  const capability = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
  assert.deepEqual(JSON.parse(capability.stdout)['com.apple.proapps.MediaAssetProtocol'], {});
  const scripting = await run('plutil', ['-extract', 'NSScriptingDefinition', 'raw', '-o', '-', plist]);
  assert.equal(scripting.stdout.trim(), 'ShareResearch.sdef');
  await run('xmllint', ['--noout', '--dtdvalid', '/System/Library/DTDs/sdef.dtd', sdef]);
  await run('xcrun', ['sdp', '-fh', '-N', 'ResearchShare', '-o', join(temporary, 'ResearchShare.h'), sdef]);
  const definition = await readFile(sdef, 'utf8');
  assert.match(definition, /<cocoa class="ResearchAsset"\/>/);
  assert.match(definition, /name="metadata" code="meta"/);
  assert.match(definition, /name="data options" code="dopt"/);
  const header = await readFile(join(temporary, 'ResearchShare.h'), 'utf8');
  assert.match(header, /ResearchShare/);
});

test('builds a temporary uninstalled bundle without launching it', { skip: process.platform !== 'darwin' }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'framekit-share-build-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, 'ShareResearch.app');
  await run(process.execPath, [new URL('./build-bundle.mjs', import.meta.url).pathname, bundle]);
  const { stat } = await import('node:fs/promises');
  const binary = join(bundle, 'Contents', 'MacOS', 'ShareResearch');
  assert.ok((await stat(binary)).isFile());
  assert.match((await run('file', ['-b', binary])).stdout, /Mach-O.*executable/);
  await run('plutil', ['-lint', join(bundle, 'Contents', 'Info.plist')]);
  assert.ok((await stat(join(bundle, 'Contents', 'Resources', 'ShareResearch.sdef'))).isFile());
  await assert.rejects(run(process.execPath, [new URL('./build-bundle.mjs', import.meta.url).pathname, bundle]));
});
