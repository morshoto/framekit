import Link from 'next/link';
import { DocsLayout } from './DocsLayout';
import { getNavigationGroups } from '../lib/docs/source';

export function EnglishOverview() {
  return <DocsLayout locale="en" title="Framekit Documentation" description="Build and inspect video editing workflows with Framekit." groups={getNavigationGroups('en')} headings={[{ id: 'start', title: 'Start here' }, { id: 'paths', title: 'Choose a path' }]} next={{ title: 'Introduction', href: '/en/docs/introduction/' }}>
    <h2 id="start">Start here</h2><p>Framekit is a local-first video editing runtime and MCP server. <Link href="/en/docs/introduction/">Learn the basics</Link>, then follow <Link href="/en/docs/installation/">Installation</Link> and <Link href="/en/docs/quick-start/">Quick Start</Link>.</p>
    <h2 id="paths">Choose a path</h2><p>Work with a Framekit-owned project using <Link href="/en/docs/headless-editing/">headless editing</Link>, connect to <Link href="/en/docs/final-cut-pro/">Final Cut Pro</Link>, or set up a checkout for <Link href="/en/docs/development/">development</Link>.</p><p>Inspect capabilities before editing. Fixture and FCPXML results do not establish a live Final Cut edit.</p>
  </DocsLayout>;
}
