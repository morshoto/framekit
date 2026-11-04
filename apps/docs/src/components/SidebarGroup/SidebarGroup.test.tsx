import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SidebarGroup } from './index';
it('marks the active link and invokes navigation', async () => { const navigate = vi.fn(); render(<SidebarGroup group={{ title: 'Guide', items: [{title:'Overview',href:'/#overview'}] }} activeHref="/#overview" onNavigate={navigate} />); const link = screen.getByRole('link', {name:'Overview'}); expect(link).toHaveAttribute('aria-current','page'); await userEvent.click(link); expect(navigate).toHaveBeenCalledOnce(); });
