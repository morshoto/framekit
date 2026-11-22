import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('troubleshooting is discoverable and warns about uncertain native edits', async () => {
  const guide = await read('../content/docs/en/troubleshooting.mdx');
  for (const symptom of ['cannot connect', 'bridge', 'media', 'preview', 'render', 'timed out', 'Undo']) assert.match(guide.toLowerCase(), new RegExp(symptom.toLowerCase()));
  assert.match(guide, /do not (blindly )?retry/i);
  assert.match(guide, /build alignment/i);
  assert.match(guide, /\/en\/docs\/error-reference\//);
  for (const slug of ['installation', 'quick-start', 'final-cut-pro', 'error-reference']) {
    assert.match(await read(`../content/docs/en/${slug}.mdx`), /\/en\/docs\/troubleshooting\//);
  }
  assert.match(await read('../src/lib/docs/source.ts'), /slug: 'troubleshooting'/);
});
