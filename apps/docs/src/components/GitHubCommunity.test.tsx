import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { loadContributors, loadFunding } from '../lib/github-community';
import { GitHubCommunity } from './GitHubCommunity';
vi.mock('../lib/github-community', () => ({ loadContributors: vi.fn(), loadFunding: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });
it('shows people and visibly identifies bots while keeping funding recipients distinct', async () => {
  vi.mocked(loadContributors).mockResolvedValue([{ login:'renovate[bot]', profile:'https://github.com/apps/renovate', avatar:'https://avatars.githubusercontent.com/in/2740', bot:true }]);
  vi.mocked(loadFunding).mockResolvedValue(['morshoto']);
  render(<GitHubCommunity />);
  expect(await screen.findByRole('link', { name: /renovate.*automated contributor/i })).toHaveAttribute('href','https://github.com/apps/renovate');
  expect(screen.getByText('⚙')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('link', { name:'Become a sponsor' })).toHaveAttribute('href','https://github.com/sponsors/morshoto'));
  expect(screen.getByLabelText('Funded maintainers')).toHaveTextContent('@morshoto');
  expect(screen.queryByText('Sponsored by')).not.toBeInTheDocument();
});
it('keeps fallback links when GitHub is rate limited or offline', async () => {
  vi.mocked(loadContributors).mockRejectedValue(new Error('403'));
  vi.mocked(loadFunding).mockRejectedValue(new Error('offline'));
  render(<GitHubCommunity />);
  expect(await screen.findByText(/GitHub is unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name:/View all contributors/ })).toHaveAttribute('href','https://github.com/morshoto/framekit/graphs/contributors');
  expect(screen.getByRole('link', { name:'Become a sponsor' })).toHaveAttribute('href','https://github.com/sponsors/morshoto');
});
it('offers contribution and funding navigation for empty successful responses', async () => {
  vi.mocked(loadContributors).mockResolvedValue([]); vi.mocked(loadFunding).mockResolvedValue([]);
  render(<GitHubCommunity />);
  expect(await screen.findByText(/No public contributors/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name:'View funding options' })).toHaveAttribute('href','https://github.com/morshoto/framekit/blob/main/.github/FUNDING.yml');
  expect(screen.getByRole('link', { name:/Become a contributor/ })).toHaveAttribute('href','/en/docs/development');
});
it('aborts both requests when the section unmounts', () => {
  vi.mocked(loadContributors).mockReturnValue(new Promise(() => {})); vi.mocked(loadFunding).mockReturnValue(new Promise(() => {}));
  const view = render(<GitHubCommunity />);
  const signal = vi.mocked(loadContributors).mock.calls[0][0];
  view.unmount(); expect(signal?.aborted).toBe(true);
});
