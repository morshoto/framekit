import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsLayout } from '../../components/DocsLayout';
import { FallbackNotice } from '../../components/FallbackNotice';
import { getNavigation, getNavigationGroups } from '../../lib/docs/source';
import { isLocale } from '../../lib/i18n/locales';
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params; if (!isLocale(lang)) return {};
  const base = process.env.DOCS_BASE_PATH || ''; const origin = process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io';
  return { title: lang === 'ja' ? 'ドキュメント | Framekit Docs' : 'Documentation | Framekit Docs', description: lang === 'ja' ? '架空のサンプルです。' : 'Synthetic placeholder content.', metadataBase: new URL(origin), alternates: { canonical: `${base}/${lang}/`, languages: { en: `${base}/en/`, ja: `${base}/ja/` } } };
}
export default async function LocaleOverview({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const items = getNavigation(lang); const title = lang === 'ja' ? 'ドキュメント' : 'Documentation';
  return <DocsLayout locale={lang} title={title} description={lang === 'ja' ? '架空のサンプルです。' : 'Synthetic placeholder content.'} groups={getNavigationGroups(lang)} headings={[]}><FallbackNotice message={lang === 'ja' ? '翻訳がないため概要を表示しています。' : 'Translation unavailable; showing the overview.'} /><p>{lang === 'ja' ? 'サンプルを選択してください。' : 'Choose a sample to explore.'}</p><ul>{items.map(item => <li key={item.href}><Link href={item.href}>{item.title}</Link></li>)}</ul></DocsLayout>;
}
