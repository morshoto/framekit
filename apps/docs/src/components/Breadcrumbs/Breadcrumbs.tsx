import Link from 'next/link';
import styles from './Breadcrumbs.module.scss';
export interface BreadcrumbsProps { current: string }
export function Breadcrumbs({ current }: BreadcrumbsProps) { return <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><ol><li><Link href="/">Docs</Link></li><li aria-current="page">{current}</li></ol></nav>; }
