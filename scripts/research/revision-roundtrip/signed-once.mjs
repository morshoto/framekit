// Offline research only. A file claim cannot fence native writers or external queues.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createSignedRevisionB } from './signed-handoff.mjs';
import { writeRevision } from './revision-store.mjs';

export async function commitSignedRevisionB(options) {
  const result = createSignedRevisionB(options);
  const key = options.trustedKey.export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(key).update(options.envelope.payload).digest('hex');
  const claimPath = join(options.claimDirectory, `claim-${id}.json`);
  // Claim first: a subsequent failure remains uncertain and cannot be blindly retried.
  await writeRevision(claimPath, result.xml, options.expectedProject);
  const output = await open(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.writeFile(result.xml); await output.sync(); }
  finally { await output.close(); }
  const directory = await open(dirname(options.output), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return { digest: result.digest, claimPath };
}
