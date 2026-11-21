import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingCodes, extractDefinedCodes, extractIndexedCodes } from '../scripts/check-error-reference.mjs';

test('reports literal error definitions missing from stable code headings', () => {
  const source = `throw new Error("HEADLESS_ONE: detail");\nthrow new Error(\`FCPXML_TWO: detail\`);\nconst setting = "FRAMEKIT_STATE_DIR";`;
  const page = '## headless-one\n\n`HEADLESS_ONE`\n\nMeaning, state and recovery.\n';
  assert.deepEqual([...extractDefinedCodes(source)].sort(), ['FCPXML_TWO', 'HEADLESS_ONE']);
  assert.deepEqual([...extractIndexedCodes(page)], ['HEADLESS_ONE']);
  assert.deepEqual(findMissingCodes([source], page), ['FCPXML_TWO']);
});

test('only exact code headings count as reference entries', () => {
  assert.deepEqual([...extractIndexedCodes('Mention `HEADLESS_ONE` here.\n\n## headless-two\n\n`HEADLESS_TWO`\n')], ['HEADLESS_TWO']);
});

test('reference covers previously documented codes and post-commit recovery', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../content/docs/en/error-reference.mdx', import.meta.url), 'utf8');
  const codes = extractIndexedCodes(page);
  for (const code of ['HEADLESS_ROUGH_CUT_HISTORY_UNCONFIRMED', 'ANALYZER_SOURCE_CHANGED', 'CAPABILITY_UNAVAILABLE', 'FINAL_CUT_NATIVE_SEARCH_TIMEOUT', 'FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE', 'FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE']) assert.ok(codes.has(code), code);
  assert.match(page, /already committed[\s\S]*reinspect/i);
});

test('code headings use stable hyphenated anchors while retaining exact codes', () => {
  assert.deepEqual([...extractIndexedCodes('## headless-one\n\n`HEADLESS_ONE`\n')], ['HEADLESS_ONE']);
  assert.deepEqual([...extractIndexedCodes('## wrong-anchor\n\n`HEADLESS_ONE`\n')], []);
});

test('reports structured error code literals as well as thrown messages', () => {
  assert.deepEqual([...extractDefinedCodes('return { code: "CAPABILITY_UNAVAILABLE", message: "no" };')], ['CAPABILITY_UNAVAILABLE']);
});
