import { describe, expect, it } from 'vitest';
import { searchDevelopmentDocs } from './development-search';
describe('development search', () => {
  it('finds a ready English page by title and description', () => {
    expect(searchDevelopmentDocs('installation', 'en').map(result => result.href)).toContain('/en/docs/installation/');
    expect(searchDevelopmentDocs('native capability', 'en').map(result => result.href)).toContain('/en/docs/final-cut-pro/');
  });
  it('restricts results to ready pages in the requested locale', () => {
    expect(searchDevelopmentDocs('インストール', 'ja')).toEqual([]);
    expect(searchDevelopmentDocs('はじめに', 'ja')).toEqual([]);
  });
});
