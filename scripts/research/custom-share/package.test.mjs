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
  const header = await readFile(join(temporary, 'ResearchShare.h'), 'utf8');
  assert.match(header, /ResearchShare/);
});
