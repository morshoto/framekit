import Link from 'next/link';
import type { NavItem } from '../../lib/navigation';
import styles from './DocsPager.module.scss';
export interface DocsPagerProps { previous?: NavItem; next?: NavItem }
export function DocsPager({ previous, next }: DocsPagerProps) { return <nav className={styles.pager} aria-label="Page navigation">{previous && <Link href={previous.href}>← Previous: {previous.title}</Link>}{next && <Link href={next.href}>Next: {next.title} →</Link>}</nav>; }
