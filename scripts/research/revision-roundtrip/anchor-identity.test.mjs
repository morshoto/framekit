import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findAnchoredTarget } from './anchor-identity.mjs';

const expected = { sourceStart: '2s', duration: '1s' };

async function fixtures() {
  const base = await readFile(new URL('./anchored-base.fcpxml', import.meta.url), 'utf8');
  const external = await readFile(new URL('./anchored-edit.fcpxml', import.meta.url), 'utf8');
  return { base, external };
}

test('embedded explicit ID survives an independent source-range edit and same-name insertion', async () => {
  const { base, external } = await fixtures();
  const result = findAnchoredTarget(base, external, 'opening-v1', expected);
  assert.equal(result.id, 'opening-v1');
  assert.equal(result.sourceStart, '2s');
  assert.equal(result.name, 'Opening');
});

test('compares anchored child timing in parent time, rejecting a shifted title and audio', async () => {
  const { base, external } = await fixtures();
  const shifted = external.replace('lane="-1" offset="2s"', 'lane="-1" offset="1s"')
    .replace('lane="2" offset="2s"', 'lane="2" offset="1s"');
  assert.notEqual(shifted, external);
  assert.equal(findAnchoredTarget(base, external, 'opening-v1', expected).id, 'opening-v1');
  assert.throws(() => findAnchoredTarget(base, shifted, 'opening-v1', expected), /structure|timing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('lane="-1" offset="2s"', 'lane="-1" offset="1s"'), 'opening-v1', expected), /structure|timing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('lane="2" offset="2s"', 'lane="2" offset="1s"'), 'opening-v1', expected), /structure|timing/);
  const equivalent = external.replace('lane="-1" offset="2s"', 'lane="-1" offset="4/2s"');
  assert.equal(findAnchoredTarget(base, equivalent, 'opening-v1', expected).id, 'opening-v1');
});

test('rejects unsupported timed children even when their raw XML is unchanged', async () => {
  const { base, external } = await fixtures();
  const insert = value => value.replace('<metadata><md key="com.framekit.id" value="opening-v1"/>', '<marker start="1s" duration="1/30s" value="mark"/><metadata><md key="com.framekit.id" value="opening-v1"/>');
  assert.throws(() => findAnchoredTarget(insert(base), insert(external), 'opening-v1', expected), /unsupported/);
  const nested = value => value.replace('/><title ref="title-effect"', '><title lane="1" offset="1s" duration="1s"/></audio><title ref="title-effect"');
  assert.notEqual(nested(base), base);
  assert.notEqual(nested(external), external);
  assert.throws(() => findAnchoredTarget(nested(base), nested(external), 'opening-v1', expected), /unsupported/);
  const retimed = value => value.replace('<metadata><md key="com.framekit.id" value="opening-v1"/>', '<timeMap><timept time="0s" value="0s"/></timeMap><metadata><md key="com.framekit.id" value="opening-v1"/>');
  assert.throws(() => findAnchoredTarget(retimed(base), retimed(external), 'opening-v1', expected), /unsupported/);
});

test('rejects copied, missing and changed anchors and source declarations', async () => {
  const { base, external } = await fixtures();
  assert.throws(() => findAnchoredTarget(base, external.replace('value="inserted-v1"', 'value="opening-v1"'), 'opening-v1', expected), /duplicate/);
  assert.throws(() => findAnchoredTarget(base, external.replace('value="opening-v1"', 'value="changed"'), 'opening-v1', expected), /missing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('<md key="com.framekit.id" value="opening-v1"/>', ''), 'opening-v1', expected), /missing/);
  assert.throws(() => findAnchoredTarget(base, external.replace('file:///synthetic/interview.mov', 'file:///synthetic/other.mov'), 'opening-v1', expected), /source/);
  assert.throws(() => findAnchoredTarget(base, external.replace('name="Opening" offset="0s"', 'name="Manual rename" offset="0s"'), 'opening-v1', expected), /conflict/);
});

test('requires an independent target-range manifest and rejects swapped IDs', async () => {
  const { base, external } = await fixtures();
  const manifest = { sourceStart: '2s', duration: '1s' };
  assert.throws(() => findAnchoredTarget(base, external, 'opening-v1'), /manifest/);
  assert.equal(findAnchoredTarget(base, external, 'opening-v1', manifest).id, 'opening-v1');
  const swapped = external.replace('value="opening-v1"', 'value="temporary-v1"')
    .replace('value="inserted-v1"', 'value="opening-v1"').replace('value="temporary-v1"', 'value="inserted-v1"');
  assert.throws(() => findAnchoredTarget(base, swapped, 'opening-v1', manifest), /manifest/);
});

test('rejects equal source intervals even when unique IDs were exchanged', async () => {
  const { base, external } = await fixtures();
  const duplicate = external.replace('</spine>', '<asset-clip ref="a" name="Opening" offset="0s" start="4/2s" duration="2/2s"><metadata><md key="com.framekit.id" value="another-v1"/></metadata></asset-clip></spine>');
  assert.throws(() => findAnchoredTarget(base, duplicate, 'opening-v1', expected), /ambiguous/);
});

test('rejects an anchored replacement that loses title and music structure', async () => {
  const { base, external } = await fixtures();
  const altered = external.replace(/<asset-clip ref="a" name="Opening" offset="0s" start="2s" duration="1s">[\s\S]*?<\/asset-clip>/,
    '<asset-clip ref="a" name="Opening" offset="0s" start="2s" duration="1s"><metadata><md key="com.framekit.id" value="opening-v1"/></metadata></asset-clip>');
  assert.notEqual(altered, external);
  assert.throws(() => findAnchoredTarget(base, altered, 'opening-v1', expected), /structure/);
});

test('rejects unexamined spine elements that may carry copied anchors', async () => {
  const { base, external } = await fixtures();
  const copied = external.replace('</spine>', '<clip name="Other" offset="3s" duration="1s"><metadata><md key="com.framekit.id" value="opening-v1"/></metadata></clip></spine>');
  const gap = external.replace('</spine>', '<gap name="Gap" offset="3s" duration="1s"/></spine>');
  assert.notEqual(copied, external);
  assert.throws(() => findAnchoredTarget(base, copied, 'opening-v1', expected), /unsupported|duplicate/);
  assert.throws(() => findAnchoredTarget(base, gap, 'opening-v1', expected), /unsupported/);
  assert.throws(() => findAnchoredTarget(gap, external, 'opening-v1', expected), /unsupported/);
});

test('rejects proxy representations even if source URL and ranges match', async () => {
  const { base, external } = await fixtures();
  const proxy = xml => xml.replace('kind="original-media"', 'kind="proxy-media"');
  assert.throws(() => findAnchoredTarget(base, proxy(external), 'opening-v1', expected), /proxy|representation/);
  assert.throws(() => findAnchoredTarget(proxy(base), external, 'opening-v1', expected), /proxy|representation/);
  const defaultOriginal = external.replace('kind="original-media" ', '');
  assert.equal(findAnchoredTarget(base, defaultOriginal, 'opening-v1', expected).id, 'opening-v1');
});
