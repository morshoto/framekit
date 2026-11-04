import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('exports every localized article with matching language and asset paths', async () => {
  const prefix = process.env.DOCS_BASE_PATH || '';
  for (const locale of ['en', 'ja']) for (const slug of ['introduction', 'getting-started', 'examples']) {
    const html = await readFile(new URL(`../out/${locale}/docs/${slug}/index.html`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<html lang="${locale}"`));
    assert.ok(html.includes(`${prefix}/${locale}/docs/${slug}/`));
    assert.match(html, /rel="canonical"/);
    if (slug === 'introduction') assert.ok(html.includes(`${prefix}/images/mock-diagram.svg`));
  }
  for (const locale of ['en','ja']) assert.ok((await stat(new URL(`../out/${locale}/index.html`, import.meta.url))).isFile());
  assert.ok((await stat(new URL('../out/404.html', import.meta.url))).isFile());
});
test('exports draft pages with section navigation and noindex', async () => {
  const prefix = process.env.DOCS_BASE_PATH || '';
  for (const locale of ['en', 'ja']) {
    const html = await readFile(new URL(`../out/${locale}/docs/installation/index.html`, import.meta.url), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, follow"/);
    assert.match(html, /data-pagefind-ignore/);
    assert.ok(html.includes(locale === 'en' ? 'Placeholder:' : 'このページは準備中です。'));
    assert.ok(html.includes(`${prefix}/${locale}/docs/quick-start/`));
  }
});
