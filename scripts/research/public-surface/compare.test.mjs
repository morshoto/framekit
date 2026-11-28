import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compareReports } from './compare.mjs';
const base = JSON.parse(await readFile('tests/fixtures/final-cut-supported-read-probe-10.7.1.json', 'utf8'));

test('identical reports record identity and cannot promote capability', () => {
  const result = compareReports(base, structuredClone(base));
  assert.equal(result.surfaceChanged, false);
  assert.equal(result.current.version, '10.7.1');
  assert.equal(result.canonicalCapabilityPromoted, false);
});

test('new declarations are reported but not promoted', () => {
  const current = structuredClone(base);
  current.finalCut.version = '99.0';
  current.supportedSurfaces.appleEvents.classes[0].properties.push({name:'new feature',access:'r'});
  current.classification.canonicalCapabilityPromoted = true;
  const result = compareReports(base, current);
  assert.equal(result.surfaceChanged, true);
  assert.equal(result.current.version, '99.0');
  assert.equal(result.canonicalCapabilityPromoted, false);
});

test('missing or malformed evidence fails closed', () => {
  assert.throws(() => compareReports(base, {}), /invalid report/);
  const current = structuredClone(base);
  current.classification.classification = 'unsupported/unknown';
  assert.equal(compareReports(base, current).current.classification, 'unsupported/unknown');
  assert.equal(compareReports(base, current).canonicalCapabilityPromoted, false);
});

test('rejects malformed version and dictionary collections', () => {
  const malformedVersion = structuredClone(base);
  malformedVersion.finalCut.version = { injected: true };
  assert.throws(() => compareReports(base, malformedVersion), /invalid report/);
  const malformedDictionary = structuredClone(base);
  malformedDictionary.supportedSurfaces.appleEvents.classes = null;
  assert.throws(() => compareReports(base, malformedDictionary), /invalid report/);
});
