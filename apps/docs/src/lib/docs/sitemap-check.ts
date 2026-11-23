import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { DocumentMeta } from './source';

export function checkSitemap(xml: string, documents: DocumentMeta[], site: string) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid sitemap XML');
  const parsed = new XMLParser({ isArray: name => name === 'url' }).parse(xml);
  const actual: string[] = (parsed.urlset?.url ?? []).map((entry: { loc: string }) => entry.loc);
  const expected = [`${site}/en/`, `${site}/ja/`, ...documents.filter(doc => doc.status === 'ready').map(doc => `${site}/${doc.locale}/docs/${doc.slug}/`)];
  for (const url of expected) if (!actual.includes(url)) throw new Error(`Missing sitemap URL: ${url}`);
  if (actual.length !== expected.length || actual.some(url => !expected.includes(url))) throw new Error('Unexpected or duplicate sitemap URL');
}
