import { describe, expect, it } from 'vitest';
import { normalizeResultPath } from './normalize-results';
describe('normalizeResultPath', () => {
  it('accepts local result paths and removes one deployment prefix', () => {
    expect(normalizeResultPath('/framekit/ja/docs/introduction/#概要', '/framekit')).toBe('/ja/docs/introduction/#%E6%A6%82%E8%A6%81');
    expect(normalizeResultPath('/en/docs/examples/', '/framekit')).toBe('/en/docs/examples/');
  });
  it('rejects protocol-relative, external and unsafe paths', () => {
    expect(normalizeResultPath('//evil.test/path', '/framekit')).toBeNull();
    expect(normalizeResultPath('https://evil.test/', '/framekit')).toBeNull();
    expect(normalizeResultPath('javascript:alert(1)', '')).toBeNull();
  });
});
