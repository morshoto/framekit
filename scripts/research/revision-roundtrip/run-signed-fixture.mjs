// Ephemeral test key and synthetic source bytes. This is not a user's approval.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createSignedRevisionB, signFixtureClaim } from './signed-handoff.mjs';
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('supply a new output path');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url));
const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url));
const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
const pair = generateKeyPairSync('ed25519');
const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
  baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
  sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
const envelope = signFixtureClaim(claim, pair.privateKey);
const result = createSignedRevisionB({ baseline, external, sourceBytes, envelope, trustedKey: pair.publicKey,
  expectedProject: claim.projectUid, expectedTarget: claim.targetId });
await writeFile(output, result.xml, { flag: 'wx' });
console.log(JSON.stringify({ baseline: hash(baseline), external: hash(external), revisionB: result.digest,
  testKeyFingerprint: hash(pair.publicKey.export({ type: 'spki', format: 'der' })) }));
