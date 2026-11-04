import styles from './SearchTrigger.module.scss';
export interface SearchTriggerProps { onClick?: () => void; disabled?: boolean }
export function SearchTrigger({ onClick, disabled = false }: SearchTriggerProps) { return <button className={styles.trigger} type="button" disabled={disabled} onClick={onClick} aria-label="Search docs"><span aria-hidden="true">⌕</span><span className={styles.label}>Search docs</span></button>; }
