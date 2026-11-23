import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { documents, getNavigation } from '../src/lib/docs/source.ts';

test('export includes every ready English page and its current source', async () => {
  const index = await readFile('out/llms.txt', 'utf8');
  const full = await readFile('out/llms-full.txt', 'utf8');
  const ready = documents.filter(doc => doc.locale === 'en' && doc.status === 'ready');
  const navigation = getNavigation('en').filter(item => ready.some(doc => item.href === `/en/docs/${doc.slug}/`));
  let lastIndex = -1; let lastFull = -1;
  for (const item of navigation) {
    const doc = ready.find(page => item.href === `/en/docs/${page.slug}/`);
    const url = `https://morshoto.github.io/framekit${item.href}`;
    const position = index.indexOf(`[${doc.title}](${url}): ${doc.description}`);
    assert.ok(position > lastIndex, `missing or unordered index entry: ${doc.slug}`); lastIndex = position;
    const source = (await readFile(`content/docs/en/${doc.slug}.mdx`, 'utf8')).trimEnd();
    const contentPosition = full.indexOf(source);
    assert.ok(contentPosition > lastFull, `missing or unordered content: ${doc.slug}`); lastFull = contentPosition;
    await access(`out/en/docs/${doc.slug}/index.html`);
  }
  assert.equal(navigation.length, ready.length);
});
