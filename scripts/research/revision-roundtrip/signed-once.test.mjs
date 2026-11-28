import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signFixtureClaim } from './signed-handoff.mjs';
import { commitSignedRevisionB } from './signed-once.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-signed-once-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url));
  const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url));
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  return { baseline, external, sourceBytes, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
    expectedProject: claim.projectUid, expectedTarget: claim.targetId, claimDirectory: dir, output: join(dir, 'b.fcpxml') };
}

test('concurrent clients materialize a signed claim at most once', async t => {
  const input = await fixture(t);
  const results = await Promise.allSettled([commitSignedRevisionB(input), commitSignedRevisionB(input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(hash(await readFile(input.output)), results.find(result => result.status === 'fulfilled').value.digest);
  await assert.rejects(commitSignedRevisionB({ ...input, output: join(input.claimDirectory, 'other.fcpxml') }), /EEXIST/);
});

test('an output collision retains the claim and never overwrites existing bytes', async t => {
  const input = await fixture(t);
  await writeFile(input.output, 'sentinel');
  await assert.rejects(commitSignedRevisionB(input), /EEXIST/);
  assert.equal(await readFile(input.output, 'utf8'), 'sentinel');
  await assert.rejects(commitSignedRevisionB({ ...input, output: join(input.claimDirectory, 'other.fcpxml') }), /EEXIST/);
});
