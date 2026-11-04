import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('static export contains the landing page, accessible links and 404', async () => {
  const html = await readFile(new URL('../out/index.html', import.meta.url), 'utf8');
  assert.match(html, /<h1[^>]*>Documentation<\/h1>/);
  assert.match(html, /Framekit/);
  assert.match(html, /github\.com\/morshoto\/framekit/);
  assert.match(html, /name="viewport"/);
  assert.match(await readFile(new URL('../out/404.html', import.meta.url), 'utf8'), /Page not found/);
  const prefix = process.env.DOCS_BASE_PATH || '';
  assert.ok(html.includes(`${prefix}/_next/`), 'assets use the configured base path');
  assert.ok(html.includes(`href="${prefix}/icon.svg?`), 'icon uses the configured base path');
  assert.match(await readFile(new URL('../out/icon.svg', import.meta.url), 'utf8'), /<svg/);
});
