import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from '../src/lib/docs/source.ts';

test('exports every translated article with its language, canonical URL and searchable body', async () => {
  const prefix = process.env.DOCS_BASE_PATH || '';
  for (const { locale, slug } of documents) {
    const route = `/${locale}/docs/${slug}/`;
    const html = await readFile(new URL(`../out${route}index.html`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<html lang="${locale}"`));
    assert.ok(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1].endsWith(prefix + route), route);
    assert.match(html, /<article[^>]*data-pagefind-body/);
    assert.doesNotMatch(html, /<meta name="robots" content="noindex|日本語版は準備中|内容は準備中|Placeholder: this page/);
  }
});

test('exports locale overviews, the docs entry point and the missing-page response', async () => {
  for (const locale of ['en', 'ja']) assert.ok((await stat(new URL(`../out/${locale}/index.html`, import.meta.url))).isFile());
  const html = await readFile(new URL('../out/en/docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /http-equiv="refresh"/i);
  assert.ok((await stat(new URL('../out/404.html', import.meta.url))).isFile());
});
