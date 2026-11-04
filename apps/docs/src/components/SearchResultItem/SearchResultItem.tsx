import Link from 'next/link';
import type { SearchResult } from '../../lib/search/normalize-results';
import styles from './SearchResultItem.module.scss';
export interface SearchResultItemProps { result: SearchResult; index: number; selected: boolean; query: string; onSelect: () => void }
function Highlight({ text, query }: { text: string; query: string }) { const position = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1; return position < 0 ? text : <>{text.slice(0,position)}<mark>{text.slice(position,position+query.length)}</mark>{text.slice(position+query.length)}</>; }
export function SearchResultItem({ result, index, selected, query, onSelect }: SearchResultItemProps) { return <li id={`search-result-${index}`} role="option" aria-selected={selected} className={styles.item}><Link href={result.href} onClick={onSelect}><strong><Highlight text={result.title} query={query} /></strong><span>{result.href}</span><p><Highlight text={result.excerpt} query={query} /></p></Link></li>; }
