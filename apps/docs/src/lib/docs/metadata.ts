import type { Metadata } from 'next';
import { getDocument, type DocumentMeta } from './source';
import type { Locale } from '../i18n/locales';

function socialMetadata(title: string, description: string, label: string, origin: string, route: string, imagePath: string): Metadata {
  const url = new URL(route, origin).href;
  const image = new URL(imagePath, origin).href;
  return {
    openGraph: { title, description, type: 'website', url, images: [{ url: image, width: 1200, height: 630, alt: label }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export function documentMetadata(doc: DocumentMeta, origin: string, base: string): Metadata {
  const route = (locale: string) => `${base}/${locale}/docs/${doc.slug}/`;
  const languages = Object.fromEntries(['en', 'ja'].filter(locale => getDocument(locale, doc.slug)).map(locale => [locale, route(locale)]));
  const title = `${doc.title} | Framekit Docs`;
  return { title, description: doc.description, metadataBase: new URL(origin), alternates: { canonical: route(doc.locale), languages }, ...socialMetadata(title, doc.description, doc.title, origin, route(doc.locale), `${base}/social/${doc.locale}/docs/${doc.slug}.png`), ...(doc.status === 'draft' ? { robots: { index: false, follow: true } } : {}) };
}

export function overviewMetadata(locale: Locale, origin: string, base: string): Metadata {
  const label = locale === 'ja' ? 'ドキュメント' : 'Documentation';
  const title = `${label} | Framekit Docs`;
  const description = locale === 'ja' ? 'Framekit の導入、動画編集、開発のための日本語ガイドです。' : 'Build and inspect video editing workflows with Framekit.';
  return { title, description, metadataBase: new URL(origin), alternates: { canonical: `${base}/${locale}/`, languages: { en: `${base}/en/`, ja: `${base}/ja/` } }, ...socialMetadata(title, description, label, origin, `${base}/${locale}/`, `${base}/social/${locale}/overview.png`) };
}
