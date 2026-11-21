import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingCodes, extractDefinedCodes, extractIndexedCodes } from '../scripts/check-error-reference.mjs';

test('reports literal error definitions missing from stable code headings', () => {
  const source = `throw new Error("HEADLESS_ONE: detail");\nthrow new Error(\`FCPXML_TWO: detail\`);\nconst setting = "FRAMEKIT_STATE_DIR";`;
  const page = '## `HEADLESS_ONE`\n\nMeaning, state and recovery.\n';
  assert.deepEqual([...extractDefinedCodes(source)].sort(), ['FCPXML_TWO', 'HEADLESS_ONE']);
  assert.deepEqual([...extractIndexedCodes(page)], ['HEADLESS_ONE']);
  assert.deepEqual(findMissingCodes([source], page), ['FCPXML_TWO']);
});

test('only exact code headings count as reference entries', () => {
  assert.deepEqual([...extractIndexedCodes('Mention `HEADLESS_ONE` here.\n\n## `HEADLESS_TWO`\n')], ['HEADLESS_TWO']);
});
