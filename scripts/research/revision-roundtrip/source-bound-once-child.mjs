// Disposable test process; inputs and key fingerprint are supplied by the test parent.
import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitSourceBoundRenumberedRevisionB } from './source-bound-once.mjs';

const [directory, expectedPin] = process.argv.slice(2);
const trustedKey = createPublicKey(await readFile(join(directory, 'public.pem')));
const pin = createHash('sha256').update(trustedKey.export({ type: 'spki', format: 'der' })).digest('hex');
if (!/^[a-f0-9]{64}$/.test(expectedPin ?? '') || pin !== expectedPin) throw new Error('key pin mismatch');
const envelope = JSON.parse(await readFile(join(directory, 'envelope.json'), 'utf8'));
const baseline = await readFile(join(directory, 'baseline.fcpxml'));
const external = await readFile(join(directory, 'external.fcpxml'));
const result = await commitSourceBoundRenumberedRevisionB({ baseline, external, envelope, trustedKey,
  sourcePaths: { a: join(directory, 'a.bin'), m: join(directory, 'm.bin') },
  expectedProject: 'project-framekit-8b68711b3f', expectedTarget: 'opening-v1',
  claimDirectory: directory, output: join(directory, 'b.fcpxml') });
console.log(JSON.stringify({ digest: result.digest }));
