import { describe, expect, it } from 'vitest';
import { documents } from './source';
import { sitemapEntries, robotsContent } from './sitemap';
import { checkSitemap } from './sitemap-check';

describe('crawler metadata', () => {
  const site = 'https://morshoto.github.io/framekit';
  it('lists the canonical landing and every ready document, but no draft', () => {
    const entries = sitemapEntries(documents, site);
    expect(entries.map(entry => entry.url)).toEqual([
      `${site}/en/`, `${site}/ja/`,
      ...documents.filter(doc => doc.status === 'ready').map(doc => `${site}/${doc.locale}/docs/${doc.slug}/`),
    ]);
    const draft = { ...documents[0], status: 'draft' as const };
    expect(sitemapEntries([draft], site).some(entry => entry.url.includes('/docs/'))).toBe(false);
  });
  it('includes only ready language alternatives for each document', () => {
    const en = documents.find(doc => doc.locale === 'en')!;
    const ja = documents.find(doc => doc.locale === 'ja' && doc.slug === en.slug)!;
    const entries = sitemapEntries([en, { ...ja, status: 'ready' }], site);
    expect(entries[2].alternates?.languages).toEqual({ en: `${site}/en/docs/${en.slug}/`, ja: `${site}/ja/docs/${en.slug}/` });
    expect(entries[3].alternates?.languages).toEqual(entries[2].alternates?.languages);
  });
  it('allows crawlers and references the deployed sitemap', () => {
    expect(robotsContent(site)).toEqual({ rules: { userAgent: '*', allow: '/' }, sitemap: `${site}/sitemap.xml` });
  });
  it('rejects an exported sitemap missing a ready document', () => {
    const ready = documents.find(doc => doc.status === 'ready')!;
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site}/en/</loc></url></urlset>`;
    expect(() => checkSitemap(xml, [ready], site)).toThrow(/missing/i);
  });
});
