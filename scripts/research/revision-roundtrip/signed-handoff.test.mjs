import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signFixtureClaim, createSignedRevisionB } from './signed-handoff.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url));
  const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url));
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: 'a'.repeat(64), m: 'b'.repeat(64) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const envelope = signFixtureClaim(claim, pair.privateKey);
  return { baseline, external, claim, envelope, privateKey: pair.privateKey, trustedKey: pair.publicKey, expectedProject: claim.projectUid, expectedTarget: claim.targetId };
}

test('test-key signed manifest binds fixture, target, range and rename to B', async () => {
  const input = await fixture();
  const result = createSignedRevisionB(input);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.match(result.xml.toString(), /Synthetic rename/);
  assert.match(result.xml.toString(), /lane="-1"/);
  assert.match(result.xml.toString(), />Intro</);
});

test('rejects wrong key, altered claim, stale bytes and wrong target', async () => {
  const input = await fixture();
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => createSignedRevisionB({ ...input, trustedKey: other.publicKey }), /signature/);
  assert.throws(() => createSignedRevisionB({ ...input, envelope: { ...input.envelope, payload: input.envelope.payload.replace('Synthetic rename', 'Forged rename') } }), /signature/);
  assert.throws(() => createSignedRevisionB({ ...input, external: Buffer.from('different') }), /stale/);
  assert.throws(() => createSignedRevisionB({ ...input, expectedTarget: 'wrong-target' }), /target/);
  assert.throws(() => createSignedRevisionB({ ...input, expectedProject: 'wrong-project' }), /target/);
});

test('same valid signed claim is replayable in this pure prototype', async () => {
  const input = await fixture();
  assert.equal(createSignedRevisionB(input).digest, createSignedRevisionB(input).digest);
});


test('rejects wrong key roles and signed noncanonical payloads', async () => {
  const input = await fixture();
  assert.throws(() => signFixtureClaim(input.claim, input.trustedKey), /key/);
  assert.throws(() => createSignedRevisionB({ ...input, trustedKey: input.privateKey }), /signature/);
  const noncanonical = JSON.stringify({ ...input.claim, extra: true });
  const signature = sign(null, Buffer.from(noncanonical), input.privateKey).toString('base64');
  assert.throws(() => createSignedRevisionB({ ...input, envelope: { payload: noncanonical, signature } }), /invalid/);
});

test('rejects media bytes that differ from signed source digests', async () => {
  const input = await fixture();
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  const claim = { ...input.claim, sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) } };
  const signed = { ...input, sourceBytes, envelope: signFixtureClaim(claim, input.privateKey) };
  assert.match(createSignedRevisionB(signed).digest, /^[a-f0-9]{64}$/);
  assert.throws(() => createSignedRevisionB({ ...signed, sourceBytes: { ...sourceBytes, m: Buffer.from('changed') } }), /stale/);
  assert.throws(() => createSignedRevisionB({ ...signed, sourceBytes: undefined }), /source/);
});
