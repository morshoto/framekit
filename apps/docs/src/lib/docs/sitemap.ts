import type { MetadataRoute } from 'next';
import type { DocumentMeta } from './source';

export const siteUrl = 'https://morshoto.github.io/framekit';

export function sitemapEntries(documents: DocumentMeta[], site: string): MetadataRoute.Sitemap {
  const ready = documents.filter(doc => doc.status === 'ready');
  const url = (doc: DocumentMeta) => `${site}/${doc.locale}/docs/${doc.slug}/`;
  return [
    { url: `${site}/en/` },
    { url: `${site}/ja/` },
    ...ready.map(doc => ({
      url: url(doc),
      alternates: { languages: Object.fromEntries(ready.filter(other => other.slug === doc.slug).map(other => [other.locale, url(other)])) },
    })),
  ];
}

export function robotsContent(site: string): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/' }, sitemap: `${site}/sitemap.xml` };
}
