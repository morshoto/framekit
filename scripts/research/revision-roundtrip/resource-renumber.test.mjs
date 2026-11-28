import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signFixtureClaim } from './signed-handoff.mjs';
import { createRenumberedRevisionB } from './resource-renumber.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url));
  const original = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url), 'utf8');
  const renamed = original.replace('id="a"', 'id="v9"').replaceAll('ref="a"', 'ref="v9"')
    .replace('id="m"', 'id="s8"').replaceAll('ref="m"', 'ref="s8"');
  assert.notEqual(renamed, original);
  const external = Buffer.from(renamed);
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1', baselineDigest: hash(baseline), externalDigest: hash(external),
    sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) }, sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  return { baseline, external, sourceBytes, claim, privateKey: pair.privateKey, trustedKey: pair.publicKey, expectedProject: claim.projectUid, expectedTarget: claim.targetId };
}
const signed = input => ({ ...input, envelope: signFixtureClaim(input.claim, input.privateKey) });

test('maps uniquely identified local resource IDs across signed independent XML edit', async t => {
  const input = await fixture();
  const result = createRenumberedRevisionB(signed(input));
  assert.equal(result.digest, hash(result.xml));
  assert.match(result.xml.toString(), /name="Synthetic rename"/);
  assert.match(result.xml.toString(), /lane="-1"/);
  assert.match(result.xml.toString(), />Intro</);
  assert.equal(result.originalExternalDigest, input.claim.externalDigest);
  assert.notEqual(result.normalizedExternalDigest, result.originalExternalDigest);
  const dir = await mkdtemp(join(tmpdir(), 'framekit-resource-remap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'b.fcpxml');
  await writeFile(output, result.xml, { flag: 'wx' });
  const run = promisify(execFile);
  assert.match((await run('python3', [new URL('./verify-anchored.py', import.meta.url).pathname, output, 'Synthetic rename'])).stdout, /manifest verified/);
  if (process.env.FRAMEKIT_RESEARCH_DTD) {
    await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, output]);
    t.diagnostic('renumbered synthetic B passed supplied DTD and independent manifest');
  }
});

test('rejects duplicate sources, ID collision and tampered signed bytes', async () => {
  const input = await fixture();
  const change = (from, to) => Buffer.from(input.external.toString().replace(from, to));
  const cases = [
    change('file:///synthetic/music.wav', 'file:///synthetic/interview.mov'),
    change('id="f"', 'id="a"'),
    change('ref="title-effect"', 'ref="v9"'),
  ];
  for (const external of cases) {
    assert.notDeepEqual(external, input.external);
    const claim = { ...input.claim, externalDigest: hash(external) };
    assert.throws(() => createRenumberedRevisionB(signed({ ...input, external, claim })), /ambiguous|collision|unsupported/);
  }
  assert.throws(() => createRenumberedRevisionB({ ...signed(input), external: Buffer.from('tampered') }), /stale/);
  assert.throws(() => createRenumberedRevisionB({ ...signed(input), sourceBytes: { ...input.sourceBytes, m: Buffer.from('changed') } }), /stale/);
});
