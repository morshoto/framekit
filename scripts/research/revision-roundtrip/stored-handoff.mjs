// Research-only composition. Orphan outputs are possible after interruption.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readRevision, writeRevision } from './revision-store.mjs';
import { createRevisionB } from './xml-handoff.mjs';

export async function createStoredRevisionB(options) {
  const { baseline, external, baselineRecord, externalRecord, output, outputRecord, projectUid } = options;
  const a = await readRevision(baselineRecord, baseline, projectUid);
  const edit = await readRevision(externalRecord, external, projectUid);
  const result = createRevisionB({ ...options, baselineDigest: a.digest, externalDigest: edit.digest });
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(result.xml); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(output), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  const record = await writeRevision(outputRecord, result.xml, projectUid);
  return { digest: result.digest, record };
}
