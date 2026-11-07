import Link from 'next/link';
import '../styles/globals.scss';
import styles from './(home)/page.module.scss';
export default function GlobalNotFound() {
  return <html lang="en"><body><main className={styles.main}><p className={styles.eyebrow}>FRAMEKIT / DOCS</p><h1>Page not found</h1><p>This page could not be found.</p><Link className={styles.link} href="/">Back to Docs</Link>{' · '}<a href="https://github.com/morshoto/framekit">GitHub</a></main></body></html>;
}
