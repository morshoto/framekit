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

it.each([['json', '{"enabled": true}'], ['ts', 'const enabled = true;']])('highlights %s while preserving snippet text', (language, code) => {
  const { container } = render(<CodeBlock code={code} language={language} />);
  const element = container.querySelector('pre code')!;
  expect(element.textContent).toBe(code);
  expect(element.querySelector('span')).not.toBeNull();
});

it('renders unknown languages as plain text', () => {
  const { container } = render(<CodeBlock code="raw <text>" language="unknown" />);
  expect(container.querySelector('pre code')).toHaveTextContent('raw <text>');
  expect(container.querySelector('pre code span')).toBeNull();
});

it('announces a clipboard failure', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  render(<CodeBlock code="example" />);
  await user.click(screen.getByRole('button', { name: 'Copy code' }));
  expect(screen.getByRole('status')).toHaveTextContent('Copy unavailable');
});

it('provides a keyboard-focusable scroll region for long code', () => {
  render(<CodeBlock code={'x'.repeat(200)} language="ts" />);
  expect(screen.getByRole('region', { name: 'Code snippet' })).toHaveAttribute('tabindex', '0');
});
