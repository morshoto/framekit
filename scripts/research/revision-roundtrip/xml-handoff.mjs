// Bounded offline research: source digests and project identity are caller assertions.
// No native identity, concurrency, arbitrary FCPXML or safe production rebase is implied.
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { bindRevision, locateTarget } from './matching.mjs';
import { findAnchoredTarget } from './anchor-identity.mjs';
const parserOptions = { preserveOrder: true, ignoreAttributes: false, trimValues: false };

function children(nodes, key) {
  return nodes.filter(node => Array.isArray(node[key]));
}
function only(nodes, key) {
  const matches = children(nodes, key);
  if (matches.length !== 1) throw new Error(`invalid ${key}`);
  return matches[0];
}
function parse(bytes, projectUid, sourceDigests) {
  const xml = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid xml');
  const document = new XMLParser(parserOptions).parse(xml);
  const root = only(document, 'fcpxml');
  const resources = only(root.fcpxml, 'resources');
  const library = only(root.fcpxml, 'library');
  const event = only(library.library, 'event');
  const project = only(event.event, 'project');
  if (project[':@']?.['@_uid'] !== projectUid) throw new Error('project mismatch');
  const sequence = only(project.project, 'sequence');
  const spine = only(sequence.sequence, 'spine');
  for (const node of spine.spine) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === 'asset-clip' || (key === '#text' && typeof value === 'string' && !value.trim())) continue;
      throw new Error(`unsupported spine child: ${key}`);
    }
  }
  const assets = new Map();
  for (const asset of children(resources.resources, 'asset')) {
    const id = asset[':@']?.['@_id'];
    const rep = only(asset.asset, 'media-rep');
    const src = rep[':@']?.['@_src'];
    if (typeof id !== 'string' || !id || assets.has(id) || typeof src !== 'string' || !src
        || !/^[a-f0-9]{64}$/.test(sourceDigests[id] ?? '')) throw new Error('invalid source');
    assets.set(id, { src, digest: sourceDigests[id] });
  }
  const clips = children(spine.spine, 'asset-clip');
  const entries = clips.map((node, i) => {
    const attrs = node[':@'] ?? {};
    const asset = assets.get(attrs['@_ref']);
    if (!asset) throw new Error('invalid source');
    const time = value => {
      if (typeof value !== 'string' || !/^\d+(?:\/[1-9]\d*)?s$/.test(value)) throw new Error('invalid time');
      return value.slice(0, -1).includes('/') ? value.slice(0, -1) : `${value.slice(0, -1)}/1`;
    };
    return { id: String(i), sourceDigest: asset.digest, sourceStart: time(attrs['@_start']), duration: time(attrs['@_duration']) };
  });
  return { document, clips, entries, assets };
}

export function createRevisionB({ baseline, external, baselineDigest, externalDigest, projectUid, sourceDigests, targetIndex, name }) {
  if (!/^[a-f0-9]{64}$/.test(baselineDigest ?? '') || !/^[a-f0-9]{64}$/.test(externalDigest ?? '')) throw new Error('invalid digest');
  bindRevision(baseline, baselineDigest);
  bindRevision(external, externalDigest);
  if (typeof projectUid !== 'string' || !projectUid || !Number.isSafeInteger(targetIndex) || targetIndex < 0
      || typeof name !== 'string' || !name || !sourceDigests || typeof sourceDigests !== 'object') throw new Error('invalid input');
  const base = parse(baseline, projectUid, sourceDigests);
  const edited = parse(external, projectUid, sourceDigests);
  for (const [id, source] of base.assets) {
    const other = edited.assets.get(id);
    if (!other || source.src !== other.src || source.digest !== other.digest) throw new Error('source mismatch');
  }
  const selected = locateTarget(base.entries, edited.entries, String(targetIndex));
  const originalName = base.clips[targetIndex][':@']?.['@_name'];
  const externalName = edited.clips[Number(selected)][':@']?.['@_name'];
  if (typeof originalName !== 'string' || externalName !== originalName) throw new Error('rename conflict');
  edited.clips[Number(selected)][':@']['@_name'] = name;
  const xml = Buffer.from(new XMLBuilder(parserOptions).build(edited.document));
  return { xml, digest: bindRevision(xml).digest };
}

// Only a constrained fixture experiment. The manifest and metadata are unauthenticated.
export function createAnchoredRevisionB({ baseline, external, baselineDigest, externalDigest, projectUid, sourceDigests, targetId, manifest, name }) {
  if (!/^[a-f0-9]{64}$/.test(baselineDigest ?? '') || !/^[a-f0-9]{64}$/.test(externalDigest ?? '')) throw new Error('invalid digest');
  bindRevision(baseline, baselineDigest);
  bindRevision(external, externalDigest);
  if (typeof projectUid !== 'string' || !projectUid || typeof name !== 'string' || !name
      || !sourceDigests || typeof sourceDigests !== 'object') throw new Error('invalid input');
  findAnchoredTarget(baseline.toString('utf8'), external.toString('utf8'), targetId, manifest);
  const base = parse(baseline, projectUid, sourceDigests);
  const edited = parse(external, projectUid, sourceDigests);
  for (const [id, source] of base.assets) {
    const other = edited.assets.get(id);
    if (!other || source.src !== other.src || source.digest !== other.digest) throw new Error('source mismatch');
  }
  const found = edited.clips.filter(clip => children(clip['asset-clip'], 'metadata').some(metadata =>
    children(metadata.metadata, 'md').some(md => md[':@']?.['@_key'] === 'com.framekit.id' && md[':@']?.['@_value'] === targetId)));
  if (found.length !== 1) throw new Error('missing or ambiguous anchor');
  found[0][':@']['@_name'] = name;
  const xml = Buffer.from(new XMLBuilder(parserOptions).build(edited.document));
  return { xml, digest: bindRevision(xml).digest };
}
