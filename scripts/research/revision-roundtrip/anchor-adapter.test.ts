import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FcpxmlDocumentAdapter } from '@framekit/final-cut/fcpxml';

test('document adapter reads retained explicit occurrence metadata from authored fixtures', async () => {
  const base = await readFile('scripts/research/revision-roundtrip/anchored-base.fcpxml', 'utf8');
  const edit = await readFile('scripts/research/revision-roundtrip/anchored-edit.fcpxml', 'utf8');
  const read = (xml: string) => FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/anchored.fcpxml', xml);
  const before = read(base).timeline.clips;
  const after = read(edit).timeline.clips;
  assert.equal(before.find(clip => clip.name === 'Opening')?.id, 'opening-v1');
  assert.equal(after.find(clip => clip.sourceStartTime?.value === '2')?.id, 'opening-v1');
  assert.equal(after.find(clip => clip.sourceStartTime?.value === '4')?.id, 'inserted-v1');
});
