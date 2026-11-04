import { describe, expect, it } from 'vitest';
import { documents, getDocument, getNavigation, localeTarget } from './source';

describe('mock document manifest', () => {
  it('provides ordered, unique documents for both locales', () => {
    for (const locale of ['en', 'ja'] as const) {
      const docs = documents.filter(doc => doc.locale === locale);
      expect(docs).toHaveLength(3);
      expect(new Set(docs.map(doc => doc.slug)).size).toBe(3);
      expect(getNavigation(locale).map(item => item.href)).toEqual(docs.sort((a,b) => a.order-b.order).map(doc => `/${locale}/docs/${doc.slug}/`));
    }
  });
  it('preserves matching slugs and falls back explicitly when missing', () => {
    expect(getDocument('ja', 'introduction')?.locale).toBe('ja');
    expect(getDocument('ja', 'missing')).toBeUndefined();
    expect(localeTarget('ja', 'introduction')).toEqual({ href: '/ja/docs/introduction/', fallback: false });
    expect(localeTarget('ja', 'missing')).toEqual({ href: '/ja/', fallback: true });
  });
});
