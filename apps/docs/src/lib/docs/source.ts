import type { Locale } from '../i18n/locales';
import slugs from './slugs.json';
export interface DocumentMeta { locale: Locale; slug: string; title: string; description: string; order: number }
const titles = {
  en: ['Introduction', 'Getting started', 'Examples'],
  ja: ['はじめに', 'はじめの一歩', 'サンプル'],
} as const;
export const documents: DocumentMeta[] = (['en', 'ja'] as const).flatMap(locale => slugs.map((slug, order) => ({ locale, slug, order, title: titles[locale][order], description: locale === 'en' ? 'Synthetic documentation example.' : 'サンプルのドキュメントです。' })));
export function getDocument(locale: string, slug: string) { return documents.find(doc => doc.locale === locale && doc.slug === slug); }
export function getNavigation(locale: Locale) { return documents.filter(doc => doc.locale === locale).sort((a,b) => a.order-b.order).map(doc => ({ title: doc.title, href: `/${locale}/docs/${doc.slug}/` })); }
export function localeTarget(locale: Locale, slug?: string) { return slug && getDocument(locale, slug) ? { href: `/${locale}/docs/${slug}/`, fallback: false } : { href: `/${locale}/`, fallback: Boolean(slug) }; }
