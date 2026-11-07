import { documents } from '../docs/source';
import type { Locale } from '../i18n/locales';
import type { SearchResult } from './normalize-results';

/** The development server has no Pagefind index. Search the published page metadata instead. */
export function searchDevelopmentDocs(query: string, locale: Locale): SearchResult[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return documents.filter(doc => doc.locale === locale && doc.status === 'ready' && terms.every(term => `${doc.title} ${doc.description}`.toLocaleLowerCase().includes(term)))
    .map(doc => ({ title: doc.title, href: `/${locale}/docs/${doc.slug}/`, excerpt: doc.description }));
}
