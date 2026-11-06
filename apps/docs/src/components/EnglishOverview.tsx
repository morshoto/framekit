import Link from 'next/link';
import { DocsLayout } from './DocsLayout';
import { getNavigationGroups } from '../lib/docs/source';
import styles from './EnglishOverview.module.scss';

export function EnglishOverview() {
  return <DocsLayout landing locale="en" title="Make video editing easier to automate" description="Use an AI assistant to inspect and work on video projects with Framekit." groups={getNavigationGroups('en')} headings={[]}>
    <div className={styles.hero}>
      <p>Start with a safe first connection, then choose whether to work with a Framekit project or connect to Final Cut Pro.</p>
      <Link className={styles.primary} href="/en/docs/installation/">Get started <span aria-hidden="true">→</span></Link>
      <Link className={styles.secondary} href="/en/docs/introduction/">Explore the documentation</Link>
    </div>
    <section className={styles.paths} aria-labelledby="paths"><div className={styles.sectionHeading}><p className={styles.eyebrow}>YOUR WORKFLOW</p><h2 id="paths">Choose your path</h2><p>Pick the setup that matches what you want to do. You can explore the others later.</p></div>
      <div className={styles.cards}>
        <Link className={styles.card} href="/en/docs/headless-editing/"><span className={styles.number}>01 / HEADLESS</span><h3>Edit without Final Cut</h3><p>Create and work with a Framekit project without opening Final Cut Pro.</p><span className={styles.requirement}>Requires: your media and a supported renderer</span><span className={styles.action}>Explore headless editing →</span></Link>
        <Link className={styles.card} href="/en/docs/final-cut-pro/"><span className={styles.number}>02 / FINAL CUT PRO</span><h3>Connect to Final Cut Pro</h3><p>Inspect a live connection and find out which operations are available.</p><span className={styles.requirement}>Requires: macOS, Final Cut Pro and the extension</span><span className={styles.action}>Explore the integration →</span></Link>
        <Link className={styles.card} href="/en/docs/development/"><span className={styles.number}>03 / CONTRIBUTORS</span><h3>Build Framekit</h3><p>Set up a checkout and use the test editor to develop and verify changes.</p><span className={styles.requirement}>Requires: Node.js, pnpm and a checkout</span><span className={styles.action}>Set up development →</span></Link>
      </div>
    </section>
    <p className={styles.note}>Framekit checks which operations your setup supports. A test editor or exported file does not by itself prove a change in a live Final Cut project.</p>
  </DocsLayout>;
}
