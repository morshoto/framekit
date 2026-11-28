// Offline experiment: XML metadata is an unauthenticated claim, not native identity.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const one = (value, kind) => {
  const entries = array(value);
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') throw new Error(`invalid ${kind}`);
  return entries[0];
};

function inspect(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid XML');
  const root = one(new XMLParser({ ignoreAttributes: false }).parse(xml).fcpxml, 'root');
  const resources = one(root.resources, 'resources');
  const project = one(one(one(root.library, 'library').event, 'event').project, 'project');
  const uid = project['@_uid'];
  if (typeof uid !== 'string' || !uid) throw new Error('invalid project');
  const spine = one(one(project.sequence, 'sequence').spine, 'spine');
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
    if (!clip.metadata || typeof clip.metadata !== 'object') throw new Error('missing anchor');
    const entries = array(one(clip.metadata, 'metadata').md).filter(item => item['@_key'] === 'com.framekit.id');
    if (entries.length === 0) throw new Error('missing anchor');
    if (entries.length !== 1) throw new Error('duplicate anchor metadata');
    const id = entries[0]['@_value'];
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid anchor');
    if (anchors.has(id)) throw new Error('duplicate anchor');
    const source = assets.get(clip['@_ref']);
    if (!source) throw new Error('invalid source');
    anchors.set(id, { id, source, name: clip['@_name'], sourceStart: clip['@_start'] });
  }
  return { uid, anchors };
}

export function findAnchoredTarget(base, external, targetId) {
  const before = inspect(base);
  const after = inspect(external);
  if (before.uid !== after.uid) throw new Error('project mismatch');
  const a = before.anchors.get(targetId);
  const b = after.anchors.get(targetId);
  if (!a || !b) throw new Error('missing target anchor');
  if (a.source !== b.source) throw new Error('source mismatch');
  if (a.name !== b.name) throw new Error('rename conflict');
  return b;
}
