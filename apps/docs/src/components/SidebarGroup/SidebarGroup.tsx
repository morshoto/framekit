import Link from 'next/link';
import type { NavGroup } from '../../lib/navigation';
import styles from './SidebarGroup.module.scss';
export interface SidebarGroupProps { group: NavGroup; activeHref?: string; onNavigate?: () => void }
export function SidebarGroup({ group, activeHref, onNavigate }: SidebarGroupProps) {
  return <details className={styles.group} open><summary>{group.title}</summary><ul>{group.items.map(item => <li key={item.href}><Link href={item.href} aria-current={item.href === activeHref ? 'page' : undefined} onClick={onNavigate}>{item.title}</Link></li>)}</ul></details>;
}
