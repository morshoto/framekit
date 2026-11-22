import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('first video guide is discoverable and describes independent verification', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  for (const phrase of ['ffmpeg', 'ffprobe', 'preview', 'FCPXML', 'troubleshooting']) assert.match(guide, new RegExp(phrase, 'i'));
  assert.match(await read('../content/docs/en/quick-start.mdx'), /\/en\/docs\/your-first-video\//);
  assert.match(await read('../src/lib/docs/source.ts'), /slug: 'your-first-video'/);
});

test('first video routes failures to the symptom guide', async () => {
  assert.match(await read('../content/docs/en/your-first-video.mdx'), /\/en\/docs\/troubleshooting\//);
});

test('does not assert an unspecified repository license', async () => {
  assert.doesNotMatch(await read('../content/docs/en/your-first-video.mdx'), /under its license/i);
});
