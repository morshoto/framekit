// Test-owned subprocess. The expected public-key fingerprint comes from its parent.
import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { commitSignedRevisionB } from './signed-once.mjs';
const [claimDirectory, output, envelopePath, publicPath, expectedPin] = process.argv.slice(2);
const trustedKey = createPublicKey(await readFile(publicPath));
const actualPin = createHash('sha256').update(trustedKey.export({ type: 'spki', format: 'der' })).digest('hex');
if (!/^[a-f0-9]{64}$/.test(expectedPin ?? '') || actualPin !== expectedPin) throw new Error('key pin mismatch');
const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url));
const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url));
const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
const result = await commitSignedRevisionB({ baseline, external, sourceBytes, envelope, trustedKey,
  expectedProject: 'project-framekit-8b68711b3f', expectedTarget: 'opening-v1', claimDirectory, output });
console.log(JSON.stringify({ digest: result.digest }));
