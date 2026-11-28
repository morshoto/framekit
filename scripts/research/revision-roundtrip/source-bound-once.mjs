// Test-only local claim; neither an atomic transaction nor a native writer fence.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createSourceBoundRenumberedRevisionB } from './source-bound-renumber.mjs';
import { writeRevision } from './revision-store.mjs';

export async function commitSourceBoundRenumberedRevisionB(options) {
  const result = await createSourceBoundRenumberedRevisionB(options);
  const key = options.trustedKey.export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(key).update(options.envelope.payload).digest('hex');
  const claimPath = join(options.claimDirectory, `claim-${id}.json`);
  // A claim preceding the output leaves uncertainty after interruption.
  await writeRevision(claimPath, result.xml, options.expectedProject);
  const output = await open(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.writeFile(result.xml); await output.sync(); } finally { await output.close(); }
  const directory = await open(dirname(options.output), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return { digest: result.digest, claimPath };
}
