// Offline experiment: XML metadata is an unauthenticated claim, not native identity.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
function canonicalTime(value, positive = false) {
  if (typeof value !== 'string' || !/^\d+(?:\/[1-9]\d*)?s$/.test(value)) throw new Error('invalid time');
  const parts = value.slice(0, -1).split('/');
  const numerator = BigInt(parts[0]);
  const denominator = BigInt(parts[1] ?? '1');
  if (positive && numerator === 0n) throw new Error('invalid duration');
  let a = numerator, b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return `${numerator / a}/${denominator / a}`;
}
function relativeTime(offset, start) {
  const [on, od] = canonicalTime(offset).split('/').map(BigInt);
  const [sn, sd] = canonicalTime(start).split('/').map(BigInt);
  const n = on * sd - sn * od;
  const d = od * sd;
  let a = n < 0n ? -n : n, b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  return `${n / a}/${d / a}`;
}
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const one = (value, kind) => {
  const entries = array(value);
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') throw new Error(`invalid ${kind}`);
  return entries[0];
};
const supportedChildren = {
  'asset-clip': new Set(['audio', 'title', 'metadata']),
  audio: new Set(),
  title: new Set(['text', 'text-style-def']),
  text: new Set(['text-style']),
  'text-style-def': new Set(['text-style']),
  'text-style': new Set(),
};
function checkSupportedChildren(node, kind) {
  if (!node || typeof node !== 'object') return;
  for (const [name, children] of Object.entries(node)) {
    if (name.startsWith('@_') || name === '#text') continue;
    if (!supportedChildren[kind].has(name)) throw new Error(`unsupported ${kind} child: ${name}`);
    if (name !== 'metadata') for (const child of array(children)) checkSupportedChildren(child, name);
  }
}

function inspect(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid XML');
  const root = one(new XMLParser({ ignoreAttributes: false }).parse(xml).fcpxml, 'root');
  const resources = one(root.resources, 'resources');
  const project = one(one(one(root.library, 'library').event, 'event').project, 'project');
  const uid = project['@_uid'];
  if (typeof uid !== 'string' || !uid) throw new Error('invalid project');
  const spine = one(one(project.sequence, 'sequence').spine, 'spine');
  for (const name of Object.keys(spine)) {
    if (!name.startsWith('@_') && name !== 'asset-clip') throw new Error(`unsupported spine child: ${name}`);
  }
  const assets = new Map();
  for (const asset of array(resources.asset)) {
    const id = asset['@_id'];
    const rep = one(asset['media-rep'], 'media representation');
    const src = rep['@_src'];
    if (typeof id !== 'string' || !id || assets.has(id) || typeof src !== 'string' || !src) throw new Error('invalid source');
    assets.set(id, src);
  }
  const anchors = new Map();
  for (const clip of array(spine['asset-clip'])) {
    checkSupportedChildren(clip, 'asset-clip');
    if (!clip.metadata || typeof clip.metadata !== 'object') throw new Error('missing anchor');
    const entries = array(one(clip.metadata, 'metadata').md).filter(item => item['@_key'] === 'com.framekit.id');
    if (entries.length === 0) throw new Error('missing anchor');
    if (entries.length !== 1) throw new Error('duplicate anchor metadata');
    const id = entries[0]['@_value'];
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid anchor');
    if (anchors.has(id)) throw new Error('duplicate anchor');
    const source = assets.get(clip['@_ref']);
    if (!source) throw new Error('invalid source');
    const structure = structuredClone(clip);
    // The fixture supports only direct audio/title anchors. Compare their
    // placement in the parent's local timeline, not their raw offsets.
    for (const kind of ['audio', 'title']) {
      for (const child of array(structure[kind])) {
        child['@_offset'] = relativeTime(child['@_offset'] ?? '0s', clip['@_start'] ?? '0s');
      }
    }
    delete structure['@_start'];
    delete structure['@_offset'];
    delete structure['@_duration'];
    anchors.set(id, { id, source, name: clip['@_name'], sourceStart: clip['@_start'], duration: clip['@_duration'], structure: JSON.stringify(structure) });
  }
  return { uid, anchors };
}

export function findAnchoredTarget(base, external, targetId, manifest) {
  if (!manifest || typeof manifest.sourceStart !== 'string' || typeof manifest.duration !== 'string') throw new Error('missing independent manifest');
  const before = inspect(base);
  const after = inspect(external);
  if (before.uid !== after.uid) throw new Error('project mismatch');
  const a = before.anchors.get(targetId);
  const b = after.anchors.get(targetId);
  if (!a || !b) throw new Error('missing target anchor');
  if (a.source !== b.source) throw new Error('source mismatch');
  if (a.name !== b.name) throw new Error('rename conflict');
  if (canonicalTime(b.sourceStart) !== canonicalTime(manifest.sourceStart)
      || canonicalTime(b.duration, true) !== canonicalTime(manifest.duration, true)) throw new Error('target manifest mismatch');
  const sameInterval = (left, right) => left.source === right.source
    && canonicalTime(left.sourceStart) === canonicalTime(right.sourceStart)
    && canonicalTime(left.duration, true) === canonicalTime(right.duration, true);
  if ([...before.anchors.values()].filter(item => sameInterval(item, a)).length !== 1
      || [...after.anchors.values()].filter(item => sameInterval(item, b)).length !== 1) throw new Error('ambiguous source interval');
  if (a.structure !== b.structure) throw new Error('target structure changed');
  return b;
}
