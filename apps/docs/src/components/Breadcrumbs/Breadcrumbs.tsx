import Link from 'next/link';
import styles from './Breadcrumbs.module.scss';
export interface BreadcrumbsProps { current: string; homeHref?: string }
export function Breadcrumbs({ current, homeHref = '/' }: BreadcrumbsProps) { return <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><ol><li><Link href={homeHref}>Docs</Link></li><li aria-current="page">{current}</li></ol></nav>; }
