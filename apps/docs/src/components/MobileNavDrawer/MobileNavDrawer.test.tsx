import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MobileNavDrawer } from './index';

it('focuses the open drawer, locks scrolling, and restores focus on Escape', async () => {
  const user = userEvent.setup(); const close = vi.fn();
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const { rerender } = render(<MobileNavDrawer open onClose={close}><a href="#intro">Introduction</a></MobileNavDrawer>);
  expect(screen.getByRole('dialog', { name: 'Documentation navigation' }).contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await user.keyboard('{Escape}'); expect(close).toHaveBeenCalledOnce();
  rerender(<MobileNavDrawer open={false} onClose={close}><a href="#intro">Introduction</a></MobileNavDrawer>);
  expect(trigger).toHaveFocus(); expect(document.body.style.overflow).toBe(''); trigger.remove();
});

it('traps keyboard focus and closes only on backdrop or close control', async () => {
  const user = userEvent.setup(); const close = vi.fn();
  const { container } = render(<MobileNavDrawer open onClose={close}><a href="#intro">Introduction</a></MobileNavDrawer>);
  const closeButton = screen.getByRole('button', { name: 'Close navigation' });
  const link = screen.getByRole('link', { name: 'Introduction' });
  link.focus(); await user.tab(); expect(closeButton).toHaveFocus();
  await user.tab({ shift: true }); expect(link).toHaveFocus();
  await user.click(screen.getByRole('dialog')); expect(close).not.toHaveBeenCalled();
  await user.click(container.firstElementChild as HTMLElement); expect(close).toHaveBeenCalledOnce();
});
