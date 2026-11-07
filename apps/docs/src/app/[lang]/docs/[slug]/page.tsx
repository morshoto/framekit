import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsLayout } from '../../../../components/DocsLayout';
import { documents, getDocument, getNavigation, getNavigationGroups, sections } from '../../../../lib/docs/source';
import { documentMetadata } from '../../../../lib/docs/metadata';
import { extractHeadings } from '../../../../lib/docs/headings';
import { isLocale } from '../../../../lib/i18n/locales';
type Params = Promise<{ lang: string; slug: string }>;
export function generateStaticParams() { return documents.map(doc => ({ lang: doc.locale, slug: doc.slug })); }
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { lang, slug } = await params; const doc = getDocument(lang, slug); if (!doc) return {};
  return documentMetadata(doc, process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io', process.env.DOCS_BASE_PATH || '');
}
export default async function DocumentPage({ params }: { params: Params }) {
  const { lang, slug } = await params; if (!isLocale(lang)) notFound(); const doc = getDocument(lang, slug); if (!doc) notFound();
  const { default: Component } = await import(`../../../../../content/docs/${lang}/${slug}.mdx`);
  const text = await readFile(join(process.cwd(), 'content/docs', lang, `${slug}.mdx`), 'utf8');
  const headings = lang === 'ja' && doc.status === 'draft' ? [] : extractHeadings(text); const items = getNavigation(lang); const index = items.findIndex(item => item.href === `/${lang}/docs/${slug}/`);
  return <DocsLayout locale={lang} slug={slug} title={doc.title} description={lang === 'ja' && doc.status === 'draft' ? undefined : doc.description} groups={getNavigationGroups(lang)} section={sections.find(section => section.key === doc.section)?.titles[lang]} status={doc.status} headings={headings} activeHref={items[index]?.href} previous={items[index - 1]} next={items[index + 1]}>{!(lang === 'ja' && doc.status === 'draft') && <Component />}</DocsLayout>;
}
