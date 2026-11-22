import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LanguageSwitcher } from './index';
it('preserves a translated slug and labels fallback', () => { const { rerender } = render(<LanguageSwitcher locale="en" slug="introduction" />); expect(screen.getByRole('link',{name:'日本語'})).toHaveAttribute('href','/ja/docs/introduction'); rerender(<LanguageSwitcher locale="en" slug="missing" />); expect(screen.getByRole('link',{name:/fallback/})).toHaveAttribute('href','/ja?fallback=1'); });
