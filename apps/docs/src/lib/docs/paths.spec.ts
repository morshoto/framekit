import { expect, it } from 'vitest';
import { withBasePath } from './paths';
it('prefixes local assets once and leaves external URLs unchanged', () => { expect(withBasePath('/images/example.svg','/framekit')).toBe('/framekit/images/example.svg'); expect(withBasePath('/framekit/images/example.svg','/framekit')).toBe('/framekit/images/example.svg'); expect(withBasePath('https://example.com/a','/framekit')).toBe('https://example.com/a'); });
