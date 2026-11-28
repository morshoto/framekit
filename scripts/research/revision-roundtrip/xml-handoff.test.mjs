import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createRevisionB } from './xml-handoff.mjs';

const read = file => readFile(new URL(file, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parser = new XMLParser({ ignoreAttributes: false });
const sourceDigests = { a: 'a'.repeat(64), m: 'b'.repeat(64) };

async function input() {
  const baseline = await read('./independent-edited.fcpxml');
  const external = await read('./external-cut.fcpxml');
  return { baseline, external, baselineDigest: hash(baseline), externalDigest: hash(external), projectUid: 'project-framekit-8b68711b3f', sourceDigests, targetIndex: 0, name: 'Approved name' };
}

test('independent cut plus rename preserves editable title and signed audio lane in revision B', async () => {
  const result = createRevisionB(await input());
  assert.equal(result.digest, hash(result.xml));
  assert.equal(XMLValidator.validate(result.xml.toString()), true);
  const project = parser.parse(result.xml.toString()).fcpxml.library.event.project;
  const clips = project.sequence.spine['asset-clip'];
  assert.deepEqual(clips.map(item => [item['@_name'], item['@_start'], item['@_duration']]), [
    ['Approved name', '1s', '1s'], ['Closing A', '3s', '1s'], ['Closing B', '4s', '1s'],
  ]);
  assert.equal(clips[0].audio['@_lane'], '-1');
  assert.equal(clips[0].audio['@_ref'], 'm');
  assert.equal(clips[0].title.text['text-style']['#text'], 'Intro');
});

test('rejects stale bytes, wrong project and duplicate target intervals', async () => {
  const value = await input();
  assert.throws(() => createRevisionB({ ...value, baselineDigest: '0'.repeat(64) }), /stale/);
  assert.throws(() => createRevisionB({ ...value, externalDigest: '0'.repeat(64) }), /stale/);
  assert.throws(() => createRevisionB({ ...value, projectUid: 'wrong' }), /project/);
  const extra = value.external.toString().replace('</spine>', '<asset-clip ref="a" name="Opening" offset="0s" start="1s" duration="1s"/></spine>');
  assert.throws(() => createRevisionB({ ...value, external: Buffer.from(extra), externalDigest: hash(extra) }), /ambiguous/);
});

test('requires pinned digests and rejects changes to source locations', async () => {
  const value = await input();
  assert.throws(() => createRevisionB({ ...value, baselineDigest: undefined }), /digest/);
  assert.throws(() => createRevisionB({ ...value, externalDigest: undefined }), /digest/);
  const altered = value.external.toString().replace('file:///synthetic/interview.mov', 'file:///synthetic/other.mov');
  assert.throws(() => createRevisionB({ ...value, external: Buffer.from(altered), externalDigest: hash(altered) }), /source mismatch/);
});

test('rejects a concurrent rename of the target occurrence', async () => {
  const value = await input();
  const changed = value.external.toString().replace('name="Opening"', 'name="Manual rename"');
  assert.throws(() => createRevisionB({ ...value, external: Buffer.from(changed), externalDigest: hash(changed) }), /conflict/);
});
