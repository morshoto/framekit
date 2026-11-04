import type { Locale } from '../i18n/locales';

export const sections = [
  { key: 'getting-started', titles: { en: 'Getting Started', ja: 'はじめに' } },
  { key: 'guides', titles: { en: 'Guides', ja: 'ガイド' } },
  { key: 'concepts', titles: { en: 'Concepts', ja: '概念' } },
  { key: 'reference', titles: { en: 'Reference', ja: 'リファレンス' } },
  { key: 'contributing', titles: { en: 'Contributing', ja: 'コントリビューション' } },
] as const;
type Section = typeof sections[number]['key'];
export interface DocumentMeta { locale: Locale; slug: string; title: string; description: string; section: Section; order: number; status: 'draft' | 'ready' }
type Page = { slug: string; section: Section; order: number; status: 'draft' | 'ready'; titles: Partial<Record<Locale, string>> };
const pages: Page[] = [
  { slug: 'introduction', section: 'getting-started', order: 0, status: 'ready', titles: { en: 'Introduction', ja: 'はじめに' } },
  { slug: 'installation', section: 'getting-started', order: 1, status: 'draft', titles: { en: 'Installation', ja: 'インストール' } },
  { slug: 'quick-start', section: 'getting-started', order: 2, status: 'draft', titles: { en: 'Quick Start', ja: 'クイックスタート' } },
  { slug: 'codex-integration', section: 'guides', order: 0, status: 'draft', titles: { en: 'Codex Integration', ja: 'Codex 連携' } },
  { slug: 'headless-editing', section: 'guides', order: 1, status: 'draft', titles: { en: 'Headless Editing', ja: 'ヘッドレス編集' } },
  { slug: 'final-cut-pro', section: 'guides', order: 2, status: 'draft', titles: { en: 'Final Cut Pro', ja: 'Final Cut Pro' } },
  { slug: 'projects-and-timeline', section: 'concepts', order: 0, status: 'draft', titles: { en: 'Projects & Timeline IR', ja: 'プロジェクトとタイムライン IR' } },
  { slug: 'revisions-and-safety', section: 'concepts', order: 1, status: 'draft', titles: { en: 'Revisions & Safety', ja: 'リビジョンと安全性' } },
  { slug: 'cli', section: 'reference', order: 0, status: 'draft', titles: { en: 'CLI Reference', ja: 'CLI リファレンス' } },
  { slug: 'mcp-tools', section: 'reference', order: 1, status: 'draft', titles: { en: 'MCP Tools', ja: 'MCP ツール' } },
  { slug: 'configuration', section: 'reference', order: 2, status: 'draft', titles: { en: 'Configuration', ja: '設定' } },
  { slug: 'development', section: 'contributing', order: 0, status: 'draft', titles: { en: 'Development', ja: '開発' } },
  { slug: 'testing', section: 'contributing', order: 1, status: 'draft', titles: { en: 'Testing', ja: 'テスト' } },
  { slug: 'architecture', section: 'contributing', order: 2, status: 'draft', titles: { en: 'Architecture', ja: 'アーキテクチャ' } },
  { slug: 'getting-started', section: 'getting-started', order: 3, status: 'ready', titles: { en: 'Getting started', ja: 'はじめの一歩' } },
  { slug: 'examples', section: 'guides', order: 3, status: 'ready', titles: { en: 'Examples', ja: 'サンプル' } },
];
export function validateRegistry(docs: DocumentMeta[]) {
  const routes = new Set<string>(); const positions = new Set<string>(); const concepts = new Map<string, DocumentMeta>();
  for (const doc of docs) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.slug)) throw new Error(`Invalid slug: ${doc.slug}`);
    if (!['en', 'ja'].includes(doc.locale) || !sections.some(section => section.key === doc.section) || !['draft', 'ready'].includes(doc.status) || !doc.title?.trim() || !doc.description?.trim()) throw new Error(`Invalid metadata: ${doc.slug}`);
    if (!Number.isSafeInteger(doc.order) || doc.order < 0) throw new Error(`Invalid order: ${doc.slug}`);
    const concept = concepts.get(doc.slug); if (concept && (concept.section !== doc.section || concept.order !== doc.order)) throw new Error(`Inconsistent page: ${doc.slug}`); concepts.set(doc.slug, doc);
    const route = `${doc.locale}/${doc.slug}`; if (routes.has(route)) throw new Error(`Duplicate route: ${route}`); routes.add(route);
    const position = `${doc.locale}/${doc.section}/${doc.order}`; if (positions.has(position)) throw new Error(`Duplicate order: ${position}`); positions.add(position);
  }
}
export function validatePages(entries: Page[]) {
  const slugs = new Set<string>(); const positions = new Set<string>();
  for (const page of entries) {
    if (slugs.has(page.slug)) throw new Error(`Duplicate page: ${page.slug}`); slugs.add(page.slug);
    const position = `${page.section}/${page.order}`; if (positions.has(position)) throw new Error(`Duplicate order: ${position}`); positions.add(position);
    const titles = Object.entries(page.titles); if (!titles.length) throw new Error(`Missing locale: ${page.slug}`);
    for (const [locale, title] of titles) {
      if (!['en', 'ja'].includes(locale)) throw new Error(`Invalid locale: ${locale}`);
      if (typeof title !== 'string' || !title.trim()) throw new Error(`Invalid title: ${page.slug}`);
    }
  }
}
validatePages(pages);
export const documents: DocumentMeta[] = pages.flatMap(page => (['en', 'ja'] as const).flatMap(locale => page.titles[locale] ? [{ locale, slug: page.slug, title: page.titles[locale]!, description: locale === 'en' ? 'Synthetic documentation example.' : 'サンプルのドキュメントです。', section: page.section, order: page.order, status: page.status }] : []));
validateRegistry(documents);
export function getDocument(locale: string, slug: string) { return documents.find(doc => doc.locale === locale && doc.slug === slug); }
export function getNavigationGroups(locale: Locale) { return sections.map(section => ({ title: section.titles[locale], items: documents.filter(doc => doc.locale === locale && doc.section === section.key).sort((a, b) => a.order - b.order).map(doc => ({ title: doc.title, href: `/${locale}/docs/${doc.slug}/` })) })).filter(group => group.items.length); }
export function getNavigation(locale: Locale) { return getNavigationGroups(locale).flatMap(group => group.items); }
export function localeTarget(locale: Locale, slug?: string) { return slug && getDocument(locale, slug) ? { href: `/${locale}/docs/${slug}/`, fallback: false } : { href: `/${locale}/`, fallback: Boolean(slug) }; }
