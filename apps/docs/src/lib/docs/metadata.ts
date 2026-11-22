import type { Metadata } from 'next';
import { getDocument, type DocumentMeta } from './source';
export function documentMetadata(doc: DocumentMeta, origin: string, base: string): Metadata {
  const route = (locale: string) => `${base}/${locale}/docs/${doc.slug}/`;
  const languages = Object.fromEntries(['en', 'ja'].filter(locale => getDocument(locale, doc.slug)).map(locale => [locale, route(locale)]));
  return { title: `${doc.title} | Framekit Docs`, description: doc.description, metadataBase: new URL(origin), alternates: { canonical: route(doc.locale), languages }, ...(doc.status === 'draft' ? { robots: { index: false, follow: true } } : {}) };
}
