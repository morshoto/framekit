import { forwardRef, type KeyboardEventHandler } from 'react';
import styles from './SearchInput.module.scss';
export interface SearchInputProps { value: string; onChange: (value: string) => void; onKeyDown?: KeyboardEventHandler<HTMLInputElement>; activeId?: string }
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ value, onChange, onKeyDown, activeId }, ref) {
  return <label className={styles.label}><span className={styles.hidden}>Search documentation</span><input ref={ref} type="search" role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={activeId} autoComplete="off" placeholder="Search documentation…" value={value} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} /></label>;
});
