import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CodeBlock } from './index';

it('labels shell snippets as terminal commands', () => {
  render(<CodeBlock code="echo hello" language="sh" />);
  expect(screen.getByText('Terminal')).toBeInTheDocument();
});

it('shows the filename for a file snippet', () => {
  render(<CodeBlock code="{}" language="json" title="config.json" />);
  expect(screen.getByText('config.json')).toBeInTheDocument();
});

it('copies code and announces success', async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  render(<CodeBlock code={'example\n'} language="ts" />);
  await user.click(screen.getByRole('button', { name: 'Copy code' }));
  expect(writeText).toHaveBeenCalledWith('example\n');
  expect(screen.getByRole('status')).toHaveTextContent('Copied');
});
