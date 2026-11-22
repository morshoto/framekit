import type { NavGroup } from '../../lib/navigation';
import { SidebarGroup } from '../SidebarGroup';
import styles from './DocsSidebar.module.scss';
export interface DocsSidebarProps { groups: NavGroup[]; activeHref?: string; onNavigate?: () => void }
export function DocsSidebar({ groups, activeHref, onNavigate }: DocsSidebarProps) { return <nav className={styles.sidebar} aria-label="Documentation">{groups.map(group => <SidebarGroup key={group.title} group={group} activeHref={activeHref} onNavigate={onNavigate} />)}</nav>; }
