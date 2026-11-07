import Link from 'next/link';
import { EnglishOverview } from '../../components/EnglishOverview';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsLayout } from '../../components/DocsLayout';
import { getNavigationGroups } from '../../lib/docs/source';
import { isLocale } from '../../lib/i18n/locales';
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params; if (!isLocale(lang)) return {};
  const base = process.env.DOCS_BASE_PATH || ''; const origin = process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io';
  return { title: lang === 'ja' ? 'ドキュメント | Framekit Docs' : 'Documentation | Framekit Docs', description: lang === 'ja' ? '日本語版は準備中です。英語版をご利用ください。' : 'Build and inspect video editing workflows with Framekit.', metadataBase: new URL(origin), alternates: { canonical: `${base}/${lang}/`, languages: { en: `${base}/en/`, ja: `${base}/ja/` } }, ...(lang === 'ja' ? { robots: { index: false, follow: true } } : {}) };
}
export default async function LocaleOverview({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  if (lang === 'en') return <EnglishOverview />;
  return <DocsLayout locale="ja" title="ドキュメント" status="draft" groups={getNavigationGroups('ja')} headings={[]}><p><Link href="/en/">英語版のドキュメントを読む</Link></p></DocsLayout>;
}
