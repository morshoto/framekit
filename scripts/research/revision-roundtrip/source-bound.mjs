// Synthetic local-file experiment only: callers supply the exact trusted paths.
// This is not a filesystem fence, native-source proof or approval protocol.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createSignedRevisionB, verifyFixtureClaim } from './signed-handoff.mjs';

function references(bytes) {
  const xml = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid XML');
  const resources = new XMLParser({ ignoreAttributes: false }).parse(xml).fcpxml?.resources;
  if (!resources || Array.isArray(resources)) throw new Error('invalid resources');
  const assets = Array.isArray(resources.asset) ? resources.asset : [resources.asset];
  const refs = {};
  for (const asset of assets) {
    const id = asset?.['@_id'];
    const rep = asset?.['media-rep'];
    if (!['a', 'm'].includes(id) || refs[id] || !rep || Array.isArray(rep)
        || (rep['@_kind'] ?? 'original-media') !== 'original-media' || typeof rep['@_src'] !== 'string') throw new Error('invalid source reference');
    refs[id] = rep['@_src'];
  }
  if (!refs.a || !refs.m) throw new Error('invalid source reference');
  return refs;
}

export async function createSourceBoundRevisionB(options) {
  const { baseline, external, sourcePaths } = options;
  if (!Buffer.isBuffer(baseline) || !Buffer.isBuffer(external) || !sourcePaths
      || Object.keys(sourcePaths).sort().join(',') !== 'a,m') throw new Error('invalid source paths');
  verifyFixtureClaim(options);
  const before = references(baseline), after = references(external);
  const sourceBytes = {};
  for (const id of ['a', 'm']) {
    const path = sourcePaths[id];
    if (typeof path !== 'string' || !isAbsolute(path) || before[id] !== pathToFileURL(path).href || after[id] !== before[id]) throw new Error('source reference mismatch');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const first = await handle.stat();
      if (!first.isFile() || first.size > 16 * 1024 * 1024) throw new Error('invalid source file');
      sourceBytes[id] = await handle.readFile();
      const last = await handle.stat();
      if (first.size !== last.size || first.mtimeMs !== last.mtimeMs || first.ino !== last.ino) throw new Error('source changed while reading');
    } finally { await handle.close(); }
  }
  return createSignedRevisionB({ ...options, sourceBytes });
}
