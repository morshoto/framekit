export interface SearchResult { title: string; href: string; excerpt: string }
export function normalizeResultPath(value: string, basePath: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, 'https://framekit.invalid');
    if (url.origin !== 'https://framekit.invalid') return null;
    const path = basePath && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) ? url.pathname.slice(basePath.length) || '/' : url.pathname;
    return `${path}${url.search}${url.hash}`;
  } catch { return null; }
}
