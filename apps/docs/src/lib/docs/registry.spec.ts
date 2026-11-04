import { describe, expect, it } from 'vitest';
import { documents, getNavigationGroups, validateRegistry } from './source';

describe('documentation registry', () => {
  it('renders the planned sections in order with valid localized metadata', () => {
    expect(getNavigationGroups('en').map(group => group.title)).toEqual(['Getting Started', 'Guides', 'Concepts', 'Reference', 'Contributing']);
    expect(documents.find(doc => doc.locale === 'en' && doc.slug === 'installation')).toMatchObject({ section: 'getting-started', status: 'draft', title: 'Installation' });
    expect(documents.every(doc => Boolean(doc.title && doc.description))).toBe(true);
  });
  it('rejects duplicate routes and invalid metadata', () => {
    const sample = documents[0];
    expect(() => validateRegistry([sample, sample])).toThrow(/duplicate/i);
    expect(() => validateRegistry([{ ...sample, slug: '../invalid' }])).toThrow(/slug/i);
    expect(() => validateRegistry([{ ...sample, order: -1 }])).toThrow(/order/i);
  });
});
it('marks draft metadata as noindex while preserving available language routes', async () => {
  const { documentMetadata } = await import('./metadata');
  const draft = documents.find(doc => doc.locale === 'en' && doc.slug === 'installation')!;
  const metadata = documentMetadata(draft, 'https://example.com', '/framekit');
  expect(metadata.robots).toEqual({ index: false, follow: true });
  expect(metadata.alternates).toEqual({ canonical: '/framekit/en/docs/installation/', languages: { en: '/framekit/en/docs/installation/', ja: '/framekit/ja/docs/installation/' } });
});
it('rejects conflicting conceptual keys across locales', () => {
  const en = documents.find(doc => doc.locale === 'en' && doc.slug === 'installation')!;
  const ja = documents.find(doc => doc.locale === 'ja' && doc.slug === 'installation')!;
  expect(() => validateRegistry([en, { ...ja, section: 'guides' }])).toThrow(/inconsistent/i);
  expect(() => validateRegistry([en, { ...ja, order: 8 }])).toThrow(/inconsistent/i);
});
it('rejects empty locale metadata rather than silently dropping it', async () => {
  const { validatePages } = await import('./source');
  expect(() => validatePages([{ slug: 'example', section: 'guides', order: 0, status: 'draft', titles: { en: '' } }])).toThrow(/title/i);
  expect(() => validatePages([{ slug: 'example', section: 'guides', order: 0, status: 'draft', titles: {} }])).toThrow(/locale/i);
});
