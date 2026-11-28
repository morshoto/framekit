import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signFixtureClaim } from './signed-handoff.mjs';
import { createSourceBoundRevisionB } from './source-bound.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('binds signed synthetic source bytes to both XML references', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-source-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePaths = { a: join(dir, 'video.bin'), m: join(dir, 'music.bin') };
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  await Promise.all(Object.keys(sourcePaths).map(id => writeFile(sourcePaths[id], sourceBytes[id])));
  const fixture = async name => Buffer.from((await readFile(new URL(name, import.meta.url), 'utf8'))
    .replace('file:///synthetic/interview.mov', pathToFileURL(sourcePaths.a).href)
    .replace('file:///synthetic/music.wav', pathToFileURL(sourcePaths.m).href));
  const baseline = await fixture('./anchored-base.fcpxml');
  const external = await fixture('./anchored-edit.fcpxml');
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const options = { baseline, external, sourcePaths, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
    expectedProject: claim.projectUid, expectedTarget: claim.targetId };
  const result = await createSourceBoundRevisionB(options);
  assert.match(result.xml.toString(), /Synthetic rename/);
  const output = join(dir, 'b.fcpxml');
  await writeFile(output, result.xml, { flag: 'wx' });
  const verifier = new URL('./verify-anchored.py', import.meta.url).pathname;
  const verified = await promisify(execFile)('python3', [verifier, output, 'Synthetic rename']);
  assert.match(verified.stdout, /manifest verified/);
  const alteredExternal = Buffer.from(external.toString().replace(pathToFileURL(sourcePaths.a).href, pathToFileURL(sourcePaths.m).href));
  await assert.rejects(createSourceBoundRevisionB({ ...options, external: alteredExternal }), /source reference/);
  await writeFile(sourcePaths.a, 'changed bytes');
  await assert.rejects(createSourceBoundRevisionB(options), /stale/);
  await writeFile(sourcePaths.a, sourceBytes.a);
  const other = join(dir, 'other.bin');
  await writeFile(other, sourceBytes.a);
  await assert.rejects(createSourceBoundRevisionB({ ...options, sourcePaths: { ...sourcePaths, a: other } }), /source reference/);
  await rm(sourcePaths.a);
  await symlink(other, sourcePaths.a);
  await assert.rejects(createSourceBoundRevisionB(options), /ELOOP|symbolic|symlink/i);
});
