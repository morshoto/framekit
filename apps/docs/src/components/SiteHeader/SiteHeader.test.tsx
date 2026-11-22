import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SiteHeader } from './index';
it('opens navigation using the labeled control', async () => { document.documentElement.dataset.theme = 'light'; const onMenu = vi.fn(); render(<SiteHeader onMenu={onMenu} />); await userEvent.click(screen.getByRole('button',{name:'Open navigation'})); expect(onMenu).toHaveBeenCalledOnce(); delete document.documentElement.dataset.theme; });
