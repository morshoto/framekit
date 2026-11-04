import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsLayout } from '../../../../components/DocsLayout';
import { documents, getDocument, getNavigation } from '../../../../lib/docs/source';
import { extractHeadings } from '../../../../lib/docs/headings';
import { isLocale } from '../../../../lib/i18n/locales';
import EnIntroduction from '../../../../../content/docs/en/introduction.mdx';
import EnGettingStarted from '../../../../../content/docs/en/getting-started.mdx';
import EnExamples from '../../../../../content/docs/en/examples.mdx';
import JaIntroduction from '../../../../../content/docs/ja/introduction.mdx';
import JaGettingStarted from '../../../../../content/docs/ja/getting-started.mdx';
import JaExamples from '../../../../../content/docs/ja/examples.mdx';
const content = { en: { introduction: EnIntroduction, 'getting-started': EnGettingStarted, examples: EnExamples }, ja: { introduction: JaIntroduction, 'getting-started': JaGettingStarted, examples: JaExamples } };
type Params = Promise<{ lang: string; slug: string }>;
export function generateStaticParams() { return documents.map(doc => ({ lang: doc.locale, slug: doc.slug })); }
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { lang, slug } = await params; const doc = getDocument(lang, slug); if (!doc) return {};
  const origin = process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io'; const base = process.env.DOCS_BASE_PATH || '';
  return { title: `${doc.title} | Framekit Docs`, description: doc.description, metadataBase: new URL(origin), alternates: { canonical: `${base}/${lang}/docs/${slug}/`, languages: { en: `${base}/en/docs/${slug}/`, ja: `${base}/ja/docs/${slug}/` } } };
}
export default async function DocumentPage({ params }: { params: Params }) {
  const { lang, slug } = await params; if (!isLocale(lang)) notFound(); const doc = getDocument(lang, slug); if (!doc) notFound();
  const Component = content[lang][slug as keyof typeof content.en]; if (!Component) notFound();
  const text = await readFile(join(process.cwd(), 'content/docs', lang, `${slug}.mdx`), 'utf8');
  const headings = extractHeadings(text); const items = getNavigation(lang); const index = items.findIndex(item => item.href === `/${lang}/docs/${slug}/`);
  return <DocsLayout locale={lang} slug={slug} title={doc.title} description={doc.description} groups={[{title: lang === 'ja' ? 'ガイド' : 'Guides',items}]} headings={headings} activeHref={items[index]?.href} previous={items[index - 1]} next={items[index + 1]}><Component /></DocsLayout>;
}
