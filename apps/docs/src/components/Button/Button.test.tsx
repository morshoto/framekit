import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './index';

describe('Button', () => {
  it('supports pointer and keyboard activation and focus', async () => {
    const user = userEvent.setup(); const click = vi.fn();
    render(<Button onClick={click}>Continue</Button>);
    const button = screen.getByRole('button', { name: 'Continue' });
    await user.tab(); expect(button).toHaveFocus();
    await user.keyboard('{Enter}'); await user.click(button);
    expect(click).toHaveBeenCalledTimes(2);
  });
  it('prevents activation while disabled or loading', async () => {
    const user = userEvent.setup(); const click = vi.fn();
    const { rerender } = render(<Button disabled onClick={click}>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
    await user.click(screen.getByRole('button'));
    rerender(<Button loading onClick={click}>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button')); expect(click).not.toHaveBeenCalled();
  });
});
