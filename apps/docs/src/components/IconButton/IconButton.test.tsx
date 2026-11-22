import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { IconButton } from './index';

it('exposes its required name and supports keyboard and disabled state', async () => {
  const user = userEvent.setup(); const click = vi.fn();
  const { rerender } = render(<IconButton label="Open menu" onClick={click}>☰</IconButton>);
  const button = screen.getByRole('button', { name: 'Open menu' });
  await user.tab(); expect(button).toHaveFocus(); await user.keyboard(' '); expect(click).toHaveBeenCalledOnce();
  rerender(<IconButton label="Open menu" disabled onClick={click}>☰</IconButton>);
  expect(button).toBeDisabled(); await user.click(button); expect(click).toHaveBeenCalledOnce();
});

it('rejects an empty accessible name', () => {
  expect(() => render(<IconButton label="  ">☰</IconButton>)).toThrow('IconButton requires a nonempty label');
});
