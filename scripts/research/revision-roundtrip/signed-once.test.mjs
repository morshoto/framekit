import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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
  return { baseline, external, sourceBytes, claim, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
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


test('separate processes share the same one-shot claim', async t => {
  const input = await fixture(t);
  const publicPath = join(input.claimDirectory, 'public.pem');
  const envelopePath = join(input.claimDirectory, 'envelope.json');
  await writeFile(publicPath, input.trustedKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(envelopePath, JSON.stringify(input.envelope));
  const pin = hash(input.trustedKey.export({ type: 'spki', format: 'der' }));
  const script = new URL('./signed-once-child.mjs', import.meta.url).pathname;
  const run = promisify(execFile);
  const args = [script, input.claimDirectory, input.output, envelopePath, publicPath, pin];
  const results = await Promise.allSettled([run(process.execPath, args), run(process.execPath, args)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.stderr, /EEXIST/);
  const winner = JSON.parse(results.find(result => result.status === 'fulfilled').value.stdout);
  assert.equal(winner.digest, hash(await readFile(input.output)));
  const later = [script, input.claimDirectory, join(input.claimDirectory, 'later.fcpxml'), envelopePath, publicPath, pin];
  await assert.rejects(run(process.execPath, later), error => /EEXIST/.test(error.stderr));
});


test('deleting the unauthenticated marker permits replay', async t => {
  const input = await fixture(t);
  const first = await commitSignedRevisionB(input);
  await unlink(first.claimPath);
  const second = await commitSignedRevisionB({ ...input, output: join(input.claimDirectory, 'replayed.fcpxml') });
  assert.equal(second.digest, first.digest);
});


test('a different trusted key creates a separate claim for the same content', async t => {
  const input = await fixture(t);
  const first = await commitSignedRevisionB(input);
  const other = generateKeyPairSync('ed25519');
  const second = await commitSignedRevisionB({ ...input, trustedKey: other.publicKey,
    envelope: signFixtureClaim(input.claim, other.privateKey), output: join(input.claimDirectory, 'other-key.fcpxml') });
  assert.equal(second.digest, first.digest);
  assert.notEqual(second.claimPath, first.claimPath);
});
