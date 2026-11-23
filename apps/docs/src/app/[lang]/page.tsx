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
  return { title: lang === 'ja' ? 'ドキュメント | Framekit Docs' : 'Documentation | Framekit Docs', description: lang === 'ja' ? 'Framekit の導入、動画編集、開発のための日本語ガイドです。' : 'Build and inspect video editing workflows with Framekit.', metadataBase: new URL(origin), alternates: { canonical: `${base}/${lang}/`, languages: { en: `${base}/en/`, ja: `${base}/ja/` } } };
}
export default async function LocaleOverview({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  if (lang === 'en') return <EnglishOverview />;
  return (
    <DocsLayout locale="ja" title="ドキュメント" status="ready" groups={getNavigationGroups('ja')} headings={[]}>
      <p>Framekit の導入、動画編集、開発のための日本語ガイドです。</p>
      <ul>
        <li><Link href="/ja/docs/introduction/">Framekit とは</Link></li>
        <li><Link href="/ja/docs/installation/">インストール手順</Link></li>
        <li><Link href="/ja/docs/quick-start/">接続を確認する</Link></li>
      </ul>
    </DocsLayout>
  );
}
