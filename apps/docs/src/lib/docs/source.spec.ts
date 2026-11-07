import { describe, expect, it } from 'vitest';
import { documents, getDocument, getNavigation, localeTarget, sections } from './source';

describe('document manifest', () => {
  it('provides ordered, unique documents for both locales', () => {
    for (const locale of ['en', 'ja'] as const) {
      const docs = documents.filter(doc => doc.locale === locale);
      expect(docs).toHaveLength(16);
      expect(new Set(docs.map(doc => doc.slug)).size).toBe(docs.length);
      const expected = sections.flatMap(section => docs.filter(doc => doc.section === section.key).sort((a, b) => a.order - b.order)).map(doc => `/${locale}/docs/${doc.slug}/`);
      expect(getNavigation(locale).map(item => item.href)).toEqual(expected);
    }
  });
  it('preserves matching slugs and falls back explicitly when missing', () => {
    expect(getDocument('ja', 'introduction')?.locale).toBe('ja');
    expect(getDocument('ja', 'missing')).toBeUndefined();
    expect(localeTarget('ja', 'introduction')).toEqual({ href: '/ja/docs/introduction/', fallback: false });
    expect(localeTarget('ja', 'missing')).toEqual({ href: '/ja/', fallback: true });
  });
});
