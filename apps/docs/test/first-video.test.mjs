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

test('separates published plugin smoke from the real-render evidence', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /published[^\n]*fixture backend/i);
  assert.match(guide, /fixture[^\n]*does not verify[^\n]*render/i);
});

test('identifies published real-media verification as scripted MCP evidence', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /published[^\n]*real-media/i);
  assert.match(guide, /scripted[^\n]*not[^\n]*prompt/i);
});

test('shows how to inspect before and after timeline evidence', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /evidence\.before/);
  assert.match(guide, /evidence\.after/);
});

test('attributes the independently licensed sample and pins its bytes', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /Sample_Flash_Animation\.webm/);
  assert.match(guide, /CC0 1\.0/);
  assert.match(guide, /e96efec0c3bf57836b54cbead8d195564ee4e1303a320b343b4fda6642ce5904/);
});

test('the proposed prompt uses the separately licensed sample', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /Use the downloaded sample\.webm/);
  assert.match(guide, /400 × 290[^\n]*12 fps/);
});

test('includes an actual output frame for the licensed sample', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /\/images\/first-video-cc0-output\.png/);
  assert.ok((await readFile(new URL('../public/images/first-video-cc0-output.png', import.meta.url))).length > 0);
});

test('gives a pinned, reproducible direct MCP path', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /@morshoto\/framekit@0\.2\.6/);
  assert.match(guide, /first-video\.mjs sample\.webm/);
  assert.match(guide, /Type `yes`/);
});

test('explains how to interpret an interrupted render checkpoint', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /`edited`[^\n]*revision/i);
  assert.match(guide, /`previewed`[^\n]*does not prove/i);
});

test('provides an independent source-to-output frame check', async () => {
  const guide = await read('../content/docs/en/your-first-video.mdx');
  assert.match(guide, /\[source\]\[render\]ssim/);
  assert.match(guide, /SSIM[^\n]*audio/i);
});
