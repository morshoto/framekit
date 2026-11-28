// Offline research only. This is not an authenticated or concurrent transaction store.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bindRevision } from './matching.mjs';

function validateInput(bytes, target) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024 || typeof target !== 'string' || !/^[a-z0-9-]{1,80}$/.test(target)) throw new Error('invalid revision input');
}

export async function writeRevision(path, bytes, target) {
  validateInput(bytes, target);
  const record = { version: 1, target, digest: bindRevision(bytes).digest };
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return record;
}

export async function readRevision(path, bytes, target) {
  validateInput(bytes, target);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('invalid revision record');
    let record;
    try { record = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('invalid revision record'); }
    if (!record || Object.keys(record).sort().join(',') !== 'digest,target,version' || record.version !== 1
        || typeof record.target !== 'string' || !/^[a-z0-9-]{1,80}$/.test(record.target)
        || typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.digest)) throw new Error('invalid revision record');
    if (record.target !== target) throw new Error('target mismatch');
    bindRevision(bytes, record.digest);
    return record;
  } finally { await handle.close(); }
}
