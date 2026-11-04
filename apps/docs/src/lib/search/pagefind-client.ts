import { withBasePath } from '../docs/paths';
import { normalizeResultPath, type SearchResult } from './normalize-results';
import type { Locale } from '../i18n/locales';

type PagefindItem = { data: () => Promise<{ url: string; plain_excerpt: string; meta: { title?: string } }> };
type PagefindApi = { init: () => Promise<void>; destroy: () => Promise<void>; options: (options: { baseUrl: string }) => Promise<void>; search: (query: string) => Promise<{ results: PagefindItem[] } | null> };
let loaded: Promise<PagefindApi> | undefined;
let currentLanguage: string | undefined;
async function getApi(locale: Locale): Promise<PagefindApi> {
  const path = withBasePath('/pagefind/pagefind.js');
  loaded ??= import(/* webpackIgnore: true */ path) as Promise<PagefindApi>;
  let api: PagefindApi;
  try { api = await loaded; } catch (error) { loaded = undefined; throw error; }
  if (currentLanguage !== locale) {
    if (currentLanguage) { await api.destroy(); currentLanguage = undefined; }
    const base = process.env.NEXT_PUBLIC_DOCS_BASE_PATH || '';
    await api.options({ baseUrl: `${base}/` });
    await api.init(); currentLanguage = locale;
  }
  return api;
}
let queue: Promise<void> = Promise.resolve();
async function performSearch(query: string, locale: Locale): Promise<SearchResult[]> {
  const api = await getApi(locale); const result = await api.search(query);
  if (!result) return [];
  const entries = await Promise.all(result.results.slice(0, 20).map(item => item.data()));
  const base = process.env.NEXT_PUBLIC_DOCS_BASE_PATH || '';
  return entries.flatMap(entry => {
    const href = normalizeResultPath(entry.url, base);
    if (!href || !(href.startsWith(`/${locale}/`) || (locale === 'en' && href === '/'))) return [];
    return [{ title: entry.meta.title || href, href, excerpt: entry.plain_excerpt || '' }];
  });
}

export function searchDocs(query: string, locale: Locale): Promise<SearchResult[]> {
  const result = queue.then(() => performSearch(query, locale));
  queue = result.then(() => undefined, () => undefined);
  return result;
}
