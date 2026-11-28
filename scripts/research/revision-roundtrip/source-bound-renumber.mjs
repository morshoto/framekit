// Disposable trusted-path research only; not a filesystem or native identity fence.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyFixtureClaim } from './signed-handoff.mjs';
import { createRenumberedRevisionB, fixtureAssetUrls } from './resource-renumber.mjs';

export async function createSourceBoundRenumberedRevisionB(options) {
  const { baseline, external, sourcePaths } = options;
  if (!Buffer.isBuffer(baseline) || !Buffer.isBuffer(external) || !sourcePaths
      || Object.keys(sourcePaths).sort().join(',') !== 'a,m') throw new Error('invalid source paths');
  verifyFixtureClaim(options); // do not open paths until signature and original XML digests match
  const before = fixtureAssetUrls(baseline), after = fixtureAssetUrls(external);
  const sourceBytes = {};
  for (const id of ['a', 'm']) {
    const path = sourcePaths[id];
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid source path');
    const url = pathToFileURL(path).href;
    if (before.get(id) !== url || ![...after.values()].includes(url)) throw new Error('source reference mismatch');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const first = await handle.stat();
      if (!first.isFile() || first.size > 16 * 1024 * 1024) throw new Error('invalid source file');
      sourceBytes[id] = await handle.readFile();
      const last = await handle.stat();
      if (first.size !== last.size || first.mtimeMs !== last.mtimeMs || first.ctimeMs !== last.ctimeMs || first.ino !== last.ino) throw new Error('source changed while reading');
    } finally { await handle.close(); }
  }
  return createRenumberedRevisionB({ ...options, sourceBytes });
}
