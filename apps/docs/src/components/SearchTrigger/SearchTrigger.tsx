import styles from './SearchTrigger.module.scss';
export interface SearchTriggerProps { onClick?: () => void; disabled?: boolean }
export function SearchTrigger({ onClick, disabled = false }: SearchTriggerProps) { return <button className={styles.trigger} type="button" disabled={disabled} onClick={event => { event.currentTarget.focus(); onClick?.(); }} aria-label="Search docs ⌘ / Ctrl K"><span aria-hidden="true">⌕</span><span className={styles.label}>Search docs</span><span className={styles.shortcut} aria-hidden="true">⌘ / Ctrl K</span></button>; }
