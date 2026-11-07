import Link from 'next/link';
import styles from './Breadcrumbs.module.scss';
export interface BreadcrumbsProps { current: string; homeHref?: string; section?: string }
export function Breadcrumbs({ current, homeHref = '/', section }: BreadcrumbsProps) { return <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><ol><li><Link href={homeHref}>Docs</Link></li>{section && <li>{section}</li>}<li aria-current="page">{current}</li></ol></nav>; }
