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
  { slug: 'introduction', section: 'getting-started', order: 0, status: 'ready', titles: { en: 'Introduction', ja: 'Framekit の概要' } },
  { slug: 'installation', section: 'getting-started', order: 1, status: 'ready', titles: { en: 'Installation', ja: 'インストール' } },
  { slug: 'quick-start', section: 'getting-started', order: 2, status: 'ready', titles: { en: 'Quick Start', ja: 'クイックスタート' } },
  { slug: 'codex-integration', section: 'guides', order: 0, status: 'ready', titles: { en: 'Codex Integration', ja: 'Codex 連携' } },
  { slug: 'headless-editing', section: 'guides', order: 1, status: 'ready', titles: { en: 'Headless Editing', ja: 'ヘッドレス編集' } },
  { slug: 'final-cut-pro', section: 'guides', order: 2, status: 'ready', titles: { en: 'Final Cut Pro', ja: 'Final Cut Pro' } },
  { slug: 'projects-and-timeline', section: 'concepts', order: 0, status: 'ready', titles: { en: 'Projects & Timeline IR', ja: 'プロジェクトとタイムライン IR' } },
  { slug: 'revisions-and-safety', section: 'concepts', order: 1, status: 'ready', titles: { en: 'Revisions & Safety', ja: 'リビジョンと安全性' } },
  { slug: 'cli', section: 'reference', order: 0, status: 'ready', titles: { en: 'CLI Reference', ja: 'CLI リファレンス' } },
  { slug: 'mcp-tools', section: 'reference', order: 1, status: 'ready', titles: { en: 'MCP Tools', ja: 'MCP ツール' } },
  { slug: 'configuration', section: 'reference', order: 2, status: 'ready', titles: { en: 'Configuration', ja: '設定' } },
  { slug: 'error-reference', section: 'reference', order: 3, status: 'ready', titles: { en: 'Error Reference', ja: 'エラーリファレンス' } },
  { slug: 'development', section: 'contributing', order: 0, status: 'ready', titles: { en: 'Development', ja: '開発' } },
  { slug: 'testing', section: 'contributing', order: 1, status: 'ready', titles: { en: 'Testing', ja: 'テスト' } },
  { slug: 'architecture', section: 'contributing', order: 2, status: 'ready', titles: { en: 'Architecture', ja: 'アーキテクチャ' } },
  { slug: 'getting-started', section: 'getting-started', order: 3, status: 'ready', titles: { en: 'Fixture setup', ja: 'フィクスチャのセットアップ' } },
  { slug: 'examples', section: 'guides', order: 3, status: 'ready', titles: { en: 'Examples', ja: 'サンプル' } },
  { slug: 'troubleshooting', section: 'guides', order: 4, status: 'ready', titles: { en: 'Troubleshooting' } },
  { slug: 'editing-capabilities', section: 'guides', order: 5, status: 'ready', titles: { en: 'Editing Capabilities' } },
  { slug: 'your-first-video', section: 'guides', order: 6, status: 'draft', titles: { en: 'Your First Video' } },
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
const englishDescriptions: Record<string, string> = {
  introduction: 'Learn what Framekit does and choose an editing path.',
  installation: 'Install Framekit and prepare your environment.',
  'quick-start': 'Connect an MCP client and inspect your editing capabilities.',
  'getting-started': 'Set up a development checkout and run the fixture server.',
  'codex-integration': 'Connect the Framekit plugin to Codex.',
  'headless-editing': 'Work with Framekit-owned projects without Final Cut Pro.',
  'final-cut-pro': 'Connect to Final Cut Pro and understand native capability limits.',
  examples: 'Explore safe, practical Framekit workflows.',
  'projects-and-timeline': 'Understand projects, sequences, and Timeline IR.',
  'revisions-and-safety': 'Use revisions, previews, verification, and recovery safely.',
  cli: 'Find the supported Framekit command-line entry points.',
  'mcp-tools': 'Discover MCP tools, capabilities, and operation lifecycles.',
  configuration: 'Configure the editor, connection, and optional analyzers.',
  'your-first-video': 'Run and verify a disposable headless video example.',
  'editing-capabilities': 'Compare editing workflows and their limits.',

  troubleshooting: 'Diagnose symptoms and recover safely.',
  'error-reference': 'Find error meanings, project state, and recovery steps.',
  development: 'Set up the repository and contribute changes.',
  testing: 'Run checks and interpret evidence levels.',
  architecture: 'Understand Framekit components and dependency boundaries.',
};
const japaneseDescriptions: Record<string, string> = {
  introduction: 'Framekit の基本と、用途に合った編集方法を紹介します。',
  installation: '必要な環境を確認し、Framekit をインストールします。',
  'quick-start': 'Codex から接続状態と使える編集機能を確認します。',
  'getting-started': '開発環境でフィクスチャサーバーを起動し、応答を確認します。',
  'codex-integration': 'Codex に Framekit プラグインを追加して接続します。',
  'headless-editing': 'Final Cut Pro を起動せずにプロジェクトを編集し、書き出します。',
  'final-cut-pro': 'Workflow Extension の接続手順と、ネイティブ操作の条件を確認します。',
  examples: '接続の診断、フィクスチャの起動、手元のメディアの編集を試します。',
  'projects-and-timeline': 'シーケンス、オカレンス、リビジョンの関係を説明します。',
  'revisions-and-safety': '編集前の確認、プレビュー、結果の検証、復旧の手順を説明します。',
  cli: 'Framekit のコマンドと引数を確認できます。',
  'mcp-tools': 'MCP ツールを調べ、目的の操作に使える経路を確認します。',
  configuration: 'バックエンド、接続先、解析コマンドの環境変数を確認できます。',
  'error-reference': 'エラーコードから編集の状態と次に確認する項目を調べます。',
  development: '開発ツールを準備し、変更を加える場所を確認します。',
  testing: '必須のチェックと、各テストで確認できる範囲を説明します。',
  architecture: 'Framekit の各コンポーネントの役割と依存関係を説明します。',
};
validatePages(pages);
export const documents: DocumentMeta[] = pages.flatMap(page => (['en', 'ja'] as const).flatMap(locale => page.titles[locale] ? [{ locale, slug: page.slug, title: page.titles[locale]!, description: locale === 'en' ? englishDescriptions[page.slug] : japaneseDescriptions[page.slug], section: page.section, order: page.order, status: page.status }] : []));
validateRegistry(documents);
export function getDocument(locale: string, slug: string) { return documents.find(doc => doc.locale === locale && doc.slug === slug); }
export function getNavigationGroups(locale: Locale) { return sections.map(section => ({ title: section.titles[locale], items: documents.filter(doc => doc.locale === locale && doc.section === section.key).sort((a, b) => a.order - b.order).map(doc => ({ title: doc.title, href: `/${locale}/docs/${doc.slug}/` })) })).filter(group => group.items.length); }
export function getNavigation(locale: Locale) { return getNavigationGroups(locale).flatMap(group => group.items); }
export function localeTarget(locale: Locale, slug?: string) { return slug && getDocument(locale, slug) ? { href: `/${locale}/docs/${slug}/`, fallback: false } : { href: `/${locale}/`, fallback: Boolean(slug) }; }
