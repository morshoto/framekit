import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { documents } from '../src/lib/docs/source.ts';

const base = process.env.DOCS_BASE_PATH || '';
const origin = process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io';
const cards = [
  ...documents.map(doc => ({ route: `${doc.locale}/docs/${doc.slug}`, image: `social/${doc.locale}/docs/${doc.slug}.png`, title: doc.title })),
  ...['en', 'ja'].map(locale => ({ route: locale, image: `social/${locale}/overview.png`, title: locale === 'ja' ? 'ドキュメント' : 'Documentation' })),
];
test('every registered page exports social metadata and a PNG card', async () => {
  for (const card of cards) {
    const html = await readFile(`out/${card.route}/index.html`, 'utf8');
    const imageUrl = `${origin}${base}/${card.image}`;
    assert.match(html, /property="og:title"/);
    assert.match(html, /property="og:description"/);
    assert.match(html, /property="og:type" content="website"/);
    assert.ok(html.includes(`property="og:url" content="${origin}${base}/${card.route}/"`));
    assert.ok(html.includes(`property="og:image" content="${imageUrl}"`));
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    const image = await readFile(`out/${card.image}`);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
  }
});
