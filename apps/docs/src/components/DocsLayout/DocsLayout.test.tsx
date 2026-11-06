import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { DocsLayout } from './index';
it('opens and closes the navigation drawer', async () => { document.documentElement.dataset.theme = 'light'; const user = userEvent.setup(); render(<DocsLayout title="Overview" groups={[]} headings={[]}>Content</DocsLayout>); const trigger = screen.getByRole('button',{name:'Open navigation'}); await user.click(trigger); expect(screen.getByRole('dialog',{name:'Documentation navigation'})).toBeInTheDocument(); await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus(); delete document.documentElement.dataset.theme; });
it('opens search with the shortcut without stealing editable-field input', async () => { document.documentElement.dataset.theme = 'light'; const user = userEvent.setup(); render(<DocsLayout title="Overview" groups={[]} headings={[]}><input aria-label="Example field" /></DocsLayout>); const field = screen.getByRole('textbox',{name:'Example field'}); await user.click(field); await user.keyboard('{Control>}k{/Control}'); expect(screen.queryByRole('dialog',{name:'Search documentation'})).not.toBeInTheDocument(); field.blur(); await user.keyboard('{Control>}k{/Control}'); expect(screen.getByRole('dialog',{name:'Search documentation'})).toBeInTheDocument(); await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog',{name:'Search documentation'})).not.toBeInTheDocument(); delete document.documentElement.dataset.theme; });
it('identifies the section and marks draft content as a placeholder', () => {
  render(<DocsLayout title="Installation" section="Getting Started" status="draft" groups={[]} headings={[]}>Future content</DocsLayout>);
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Getting Started');
  expect(screen.getByText(/placeholder/i)).toBeInTheDocument();
  expect(screen.getByText('Future content').closest('article')).toHaveAttribute('data-pagefind-ignore');
});
it('offers the English page for an unfinished Japanese translation without an empty contents menu', () => {
  render(<DocsLayout locale="ja" slug="quick-start" title="クイックスタート" status="draft" groups={[]} headings={[]}>準備中</DocsLayout>);
  expect(screen.getByRole('link', { name: /英語版/ })).toHaveAttribute('href', '/en/docs/quick-start');
  expect(screen.queryByRole('navigation', { name: /On this page|このページ/ })).not.toBeInTheDocument();
});
