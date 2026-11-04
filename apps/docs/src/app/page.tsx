import Link from 'next/link';
import styles from './page.module.scss';

export default function Home() {
  return <div className={styles.page}>
    <header className={styles.header}><Link className={styles.wordmark} href="/">Framekit</Link><nav aria-label="Main navigation"><Link href="/">Docs</Link><a href="https://github.com/morshoto/framekit">GitHub</a></nav></header>
    <main className={styles.main}><p className={styles.eyebrow}>FRAMEKIT / DOCS</p><h1>Documentation</h1><p>Welcome to Framekit Docs. This is placeholder content.</p><Link className={styles.link} href="/">Explore the docs <span aria-hidden="true">→</span></Link></main>
    <footer className={styles.footer}>Framekit Docs · Placeholder content</footer>
  </div>;
}
