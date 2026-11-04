import { DocsLayout } from '../../components/DocsLayout';
import { mockHeadings, mockNavigation } from '../../lib/navigation';
import styles from './page.module.scss';

export default function Home() {
  return <DocsLayout title="Documentation" description="Placeholder content for Framekit Docs." groups={mockNavigation} headings={mockHeadings} activeHref="/#overview" next={{title:'First steps',href:'/#first-steps'}}>
    <h2 id="overview">Overview</h2><p>This page contains sample content for exploring the documentation layout.</p>
    <h2 id="first-steps">First steps</h2><p>Use the navigation to explore these placeholder sections.</p><pre><code>{'const example = "placeholder";'}</code></pre>
    <h2 id="example">Example workflow</h2><p>A long identifier such as <code>example_documentation_placeholder_value</code> should remain readable on small screens.</p>
    <div className={styles.tableWrap}><table><thead><tr><th>Placeholder</th><th>Example value</th></tr></thead><tbody><tr><td>Sample</td><td>A long synthetic value for testing narrow layouts</td></tr></tbody></table></div><h2 id="resources">More resources</h2><p>Visit the <a href="https://github.com/morshoto/framekit">GitHub repository</a> for the project.</p>
  </DocsLayout>;
}
