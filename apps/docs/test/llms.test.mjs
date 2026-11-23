import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLlms } from '../scripts/generate-llms.mjs';

const pages = [
  { locale: 'en', status: 'ready', slug: 'first', title: 'First', description: 'First description' },
  { locale: 'ja', status: 'ready', slug: 'first', title: 'Japanese', description: 'Excluded' },
  { locale: 'en', status: 'draft', slug: 'draft', title: 'Draft', description: 'Excluded' },
  { locale: 'en', status: 'ready', slug: 'second', title: 'Second', description: 'Second description' },
];

test('generates ordered English index and full text from current sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-llms-'));
  try {
    const content = join(dir, 'content'); const out = join(dir, 'out');
    await mkdir(join(content, 'en'), { recursive: true }); await mkdir(out);
    await writeFile(join(content, 'en', 'first.mdx'), '## First content\n\nOriginal text.\n');
    await writeFile(join(content, 'en', 'second.mdx'), '## Second content\n\nSecond text.\n');
    await generateLlms(pages, content, out);
    const index = await readFile(join(out, 'llms.txt'), 'utf8');
    const full = await readFile(join(out, 'llms-full.txt'), 'utf8');
    assert.match(index, /\[First\]\(https:\/\/morshoto\.github\.io\/framekit\/en\/docs\/first\/\): First description/);
    assert.ok(index.indexOf('[First]') < index.indexOf('[Second]'));
    assert.doesNotMatch(index + full, /Japanese|Draft|Excluded/);
    assert.ok(full.indexOf('Original text.') < full.indexOf('Second text.'));
    await writeFile(join(content, 'en', 'first.mdx'), '## First content\n\nUpdated text.\n');
    const added = { locale: 'en', status: 'ready', slug: 'third', title: 'Third', description: 'New page' };
    await writeFile(join(content, 'en', 'third.mdx'), 'New content.\n');
    await generateLlms([...pages, added], content, out);
    assert.match(await readFile(join(out, 'llms.txt'), 'utf8'), /\[Third\].*New page/);
    const updated = await readFile(join(out, 'llms-full.txt'), 'utf8');
    assert.match(updated, /Updated text\./);
    assert.match(updated, /New content\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
