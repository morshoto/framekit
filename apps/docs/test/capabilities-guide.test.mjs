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
