import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findAnchoredTarget } from './anchor-identity.mjs';

async function fixtures() {
  const base = await readFile(new URL('./anchored-base.fcpxml', import.meta.url), 'utf8');
  const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url), 'utf8');
  return { base, external };
}

test('embedded explicit ID survives an independent source-range edit and same-name insertion', async () => {
  const { base, external } = await fixtures();
  const result = findAnchoredTarget(base, external, 'opening-v1');
  assert.equal(result.id, 'opening-v1');
  assert.equal(result.sourceStart, '2s');
  assert.equal(result.name, 'Opening');
});

test('rejects copied, missing and changed anchors and source declarations', async () => {
  const { base, external } = await fixtures();
  assert.throws(() => findAnchoredTarget(base, external.replace('value="inserted-v1"', 'value="opening-v1"'), 'opening-v1'), /duplicate/);
  assert.throws(() => findAnchoredTarget(base, external.replace('value="opening-v1"', 'value="changed"'), 'opening-v1'), /missing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('<md key="com.framekit.id" value="opening-v1"/>', ''), 'opening-v1'), /missing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('file:///synthetic/interview.mov', 'file:///synthetic/other.mov'), 'opening-v1'), /source/);
  assert.throws(() => findAnchoredTarget(base, external.replace('name="Opening" offset="0s"', 'name="Manual rename" offset="0s"'), 'opening-v1'), /conflict/);
});
