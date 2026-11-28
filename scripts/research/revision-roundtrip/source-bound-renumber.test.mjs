import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signFixtureClaim } from './signed-handoff.mjs';
import { createSourceBoundRenumberedRevisionB } from './source-bound-renumber.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('binds source files across renumbered signed revisions and verifies B', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-renumber-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { a: join(dir, 'video.bin'), m: join(dir, 'music.bin') };
  const bytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  await Promise.all(['a', 'm'].map(id => writeFile(paths[id], bytes[id])));
  const fixture = async name => (await readFile(new URL(name, import.meta.url), 'utf8'))
    .replace('file:///synthetic/interview.mov', pathToFileURL(paths.a).href)
    .replace('file:///synthetic/music.wav', pathToFileURL(paths.m).href);
  const baseline = Buffer.from(await fixture('./anchored-base.fcpxml'));
  const edited = (await fixture('./anchored-edit.fcpxml')).replace('id="a"', 'id="v9"').replaceAll('ref="a"', 'ref="v9"')
    .replace('id="m"', 'id="s8"').replaceAll('ref="m"', 'ref="s8"');
  const external = Buffer.from(edited);
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1', baselineDigest: hash(baseline), externalDigest: hash(external),
    sourceDigests: { a: hash(bytes.a), m: hash(bytes.m) }, sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const input = { baseline, external, sourcePaths: paths, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
    expectedProject: claim.projectUid, expectedTarget: claim.targetId };
  const result = await createSourceBoundRenumberedRevisionB(input);
  const out = join(dir, 'b.fcpxml');
  await writeFile(out, result.xml, { flag: 'wx' });
  assert.equal(result.digest, hash(result.xml));
  assert.match((await promisify(execFile)('python3', [new URL('./verify-anchored.py', import.meta.url).pathname, out, 'Synthetic rename'])).stdout, /manifest verified/);
  if (process.env.FRAMEKIT_RESEARCH_DTD) {
    await promisify(execFile)('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, out]);
    t.diagnostic('source-bound renumbered B passed supplied DTD and independent manifest');
  }
  await assert.rejects(createSourceBoundRenumberedRevisionB({ ...input, external: Buffer.from('changed') }), /stale/);
  await assert.rejects(createSourceBoundRenumberedRevisionB({ ...input, sourcePaths: { ...paths, a: join(dir, 'missing') },
    envelope: { ...input.envelope, signature: Buffer.alloc(64).toString('base64') } }), /signature/);
  await assert.rejects(createSourceBoundRenumberedRevisionB({ ...input, sourcePaths: { ...paths, a: paths.m } }), /source reference/);
  await writeFile(paths.m, 'changed');
  await assert.rejects(createSourceBoundRenumberedRevisionB(input), /stale/);
  await rm(paths.m);
  await symlink(paths.a, paths.m);
  await assert.rejects(createSourceBoundRenumberedRevisionB(input), /ELOOP|symbolic|symlink/i);
});
