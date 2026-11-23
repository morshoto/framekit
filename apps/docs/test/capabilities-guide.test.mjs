import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('capabilities guide distinguishes workflows and is discoverable', async () => {
  const guide = await read('../content/docs/en/editing-capabilities.mdx');
  for (const phrase of ['Headless', 'FCPXML', 'Final Cut', 'revision', 'uncertain']) assert.match(guide, new RegExp(phrase, 'i'));
  for (const slug of ['introduction', 'quick-start', 'headless-editing', 'final-cut-pro', 'mcp-tools']) assert.match(await read(`../content/docs/en/${slug}.mdx`), /\/en\/docs\/editing-capabilities\//);
  assert.match(await read('../src/lib/docs/source.ts'), /slug: 'editing-capabilities'/);
});

test('headless guidance states actionable media, effect, and output constraints', async () => {
  const guide = await read('../content/docs/en/editing-capabilities.mdx');
  for (const phrase of ['regular file', 'ffprobe', 'pre-roll', 'glyph', 'mp4', 'mov']) {
    assert.match(guide, new RegExp(phrase, 'i'));
  }
});

test('states the native extension deployment target separately from its build SDK', async () => {
  const guide = await read('../content/docs/en/editing-capabilities.mdx');
  assert.match(guide, /macOS 15\.0/);
  assert.match(guide, /macOS 15\.5 SDK/);
});
