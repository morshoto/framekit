import Link from 'next/link';
import { IconButton } from '../IconButton';
import { SearchTrigger } from '../SearchTrigger';
import { ThemeToggle } from '../ThemeToggle';
import styles from './SiteHeader.module.scss';
export interface SiteHeaderProps { onMenu: () => void }
export function SiteHeader({ onMenu }: SiteHeaderProps) { return <header className={styles.header}><div className={styles.inner}><span className={styles.menu}><IconButton label="Open navigation" onClick={onMenu}>☰</IconButton></span><Link href="/" className={styles.brand}>Framekit <span>Docs</span></Link><div className={styles.actions}><SearchTrigger disabled /><span className={styles.locale} aria-label="Language: English">EN</span><ThemeToggle /><a className={styles.github} href="https://github.com/morshoto/framekit">GitHub</a></div></div></header>; }
