'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { searchDocs } from '../../lib/search/pagefind-client';
import type { SearchResult } from '../../lib/search/normalize-results';
import { EmptySearchState } from '../EmptySearchState';
import { SearchInput } from '../SearchInput';
import { SearchResultList } from '../SearchResultList';
import styles from './SearchDialog.module.scss';
export interface SearchDialogProps { open: boolean; locale: Locale; onClose: () => void; search?: (query: string, locale: Locale) => Promise<SearchResult[]>; initialQuery?: string }
type State = 'idle' | 'loading' | 'ready' | 'error';
export function SearchDialog({ open, locale, onClose, search = searchDocs, initialQuery = '' }: SearchDialogProps) {
  const panel = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null); const close = useRef(onClose); close.current = onClose;
  const [query, setQuery] = useState(initialQuery); const [state, setState] = useState<State>('idle'); const [results, setResults] = useState<SearchResult[]>([]); const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; input.current?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const elements = [...panel.current.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]), a[href]')];
      if (!elements.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); setState('idle'); setSelected(0); return; }
    let active = true; setResults([]); setSelected(0); setState('loading');
    const timer = setTimeout(() => { search(query.trim(), locale).then(items => { if (active) { setResults(items); setSelected(0); setState('ready'); } }).catch(() => { if (active) { setResults([]); setState('error'); } }); }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [open, query, locale, search]);
  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
    else if (event.key === 'Enter') { event.preventDefault(); document.querySelector<HTMLAnchorElement>(`#search-result-${selected}`)?.click(); }
  }
  if (!open) return null;
  const status = state === 'loading' ? 'Searching…' : state === 'ready' ? `${results.length} results` : state === 'error' ? 'Search unavailable' : 'Type to search documentation';
  return <div className={styles.overlay} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} role="dialog" aria-modal="true" aria-label="Search documentation" className={styles.dialog}>
    <div className={styles.heading}><strong>Search docs</strong><button type="button" onClick={onClose} aria-label="Close search">×</button></div>
    <SearchInput ref={input} value={query} onChange={setQuery} onKeyDown={navigate} activeId={results.length ? `search-result-${selected}` : undefined} />
    <div className={styles.results}><p role="status" className={styles.status}>{status}</p>{state === 'error' && <p className={styles.error}>Search unavailable. <Link href={`/${locale}/`} onClick={onClose}>Browse docs</Link>.</p>}{state === 'ready' && !results.length && <EmptySearchState message="No results found." />}<SearchResultList results={results} selected={selected} query={query} onSelect={onClose} /></div>
  </div></div>;
}
