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
