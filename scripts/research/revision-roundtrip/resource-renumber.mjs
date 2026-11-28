// Fixture-only ID remapping: signed claims and source bytes are caller-supplied.
// This does not authenticate a URL, a native occurrence, or a user's approval.
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { verifyFixtureClaim } from './signed-handoff.mjs';
import { bindRevision } from './matching.mjs';
import { createAnchoredRevisionB } from './xml-handoff.mjs';

const options = { preserveOrder: true, ignoreAttributes: false, trimValues: false };
const nodes = (items, key) => items.filter(item => Array.isArray(item[key]));
function only(items, key) {
  const found = nodes(items, key);
  if (found.length !== 1) throw new Error(`invalid ${key}`);
  return found[0];
}
function parse(bytes) {
  const xml = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid XML');
  const document = new XMLParser(options).parse(xml);
  const root = only(document, 'fcpxml');
  if (root[':@']?.['@_version'] !== '1.11') throw new Error('unsupported FCPXML version');
  const resources = only(root.fcpxml, 'resources').resources;
  const ids = new Set();
  for (const node of resources) {
    const id = node[':@']?.['@_id'];
    if (id === undefined) continue;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('resource ID collision');
    ids.add(id);
  }
  const assets = new Map(), urls = new Set();
  for (const asset of nodes(resources, 'asset')) {
    const id = asset[':@']?.['@_id'];
    const rep = only(asset.asset, 'media-rep');
    const url = rep[':@']?.['@_src'];
    if ((rep[':@']?.['@_kind'] ?? 'original-media') !== 'original-media') throw new Error('unsupported media representation');
    if (typeof id !== 'string' || typeof url !== 'string' || !url || urls.has(url)) throw new Error('ambiguous asset source');
    urls.add(url); assets.set(id, { url, node: asset });
  }
  if (assets.size !== 2) throw new Error('unsupported asset count');
  return { document, resources, ids, assets };
}

export function createRenumberedRevisionB(input) {
  const claim = verifyFixtureClaim(input); // bind the original external bytes before normalization
  if (!input.sourceBytes || !Buffer.isBuffer(input.sourceBytes.a) || !Buffer.isBuffer(input.sourceBytes.m)) throw new Error('invalid source bytes');
  for (const id of ['a', 'm']) {
    if (input.sourceBytes[id].length > 16 * 1024 * 1024) throw new Error('invalid source bytes');
    bindRevision(input.sourceBytes[id], claim.sourceDigests[id]);
  }
  const base = parse(input.baseline), external = parse(input.external);
  if (!base.assets.has('a') || !base.assets.has('m')) throw new Error('unsupported baseline assets');
  const mapping = new Map();
  for (const [externalId, value] of external.assets) {
    const matches = [...base.assets].filter(([, candidate]) => candidate.url === value.url);
    if (matches.length !== 1) throw new Error('ambiguous asset source');
    mapping.set(externalId, matches[0][0]);
  }
  if (new Set(mapping.values()).size !== 2) throw new Error('ambiguous asset source');
  for (const node of external.resources) {
    const id = node[':@']?.['@_id'];
    if (!Array.isArray(node.asset) && ['a', 'm'].includes(id)) throw new Error('resource ID collision');
  }
  function visit(items) {
    for (const node of items) {
      for (const [kind, children] of Object.entries(node)) {
        if (!Array.isArray(children)) continue;
        const attrs = node[':@'];
        if (kind === 'asset' && attrs?.['@_id'] !== undefined) attrs['@_id'] = mapping.get(attrs['@_id']);
        const ref = attrs?.['@_ref'];
        if (mapping.has(ref)) {
          if (!['asset-clip', 'audio'].includes(kind)) throw new Error('unsupported asset reference');
          attrs['@_ref'] = mapping.get(ref);
        }
        visit(children);
      }
    }
  }
  visit(external.document);
  const normalized = Buffer.from(new XMLBuilder(options).build(external.document));
  const result = createAnchoredRevisionB({ baseline: input.baseline, external: normalized,
    baselineDigest: claim.baselineDigest, externalDigest: bindRevision(normalized).digest,
    projectUid: claim.projectUid, targetId: claim.targetId, sourceDigests: claim.sourceDigests,
    manifest: { sourceStart: claim.sourceStart, duration: claim.duration }, name: claim.name });
  return { ...result, originalExternalDigest: claim.externalDigest, normalizedExternalDigest: bindRevision(normalized).digest };
}
