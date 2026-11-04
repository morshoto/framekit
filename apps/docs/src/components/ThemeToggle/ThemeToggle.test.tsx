import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, expect, it, vi } from 'vitest';
beforeAll(() => { window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
import { ThemeToggle } from './index';
it('changes and persists an explicit theme', async () => { document.documentElement.dataset.theme = 'light'; render(<ThemeToggle />); await userEvent.click(screen.getByRole('button',{name:'Switch to dark theme'})); expect(document.documentElement.dataset.theme).toBe('dark'); expect(localStorage.getItem('framekit-docs-theme')).toBe('dark'); delete document.documentElement.dataset.theme; localStorage.clear(); });
