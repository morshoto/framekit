import type { SearchResult } from '../../lib/search/normalize-results';
import { SearchResultItem } from '../SearchResultItem';
import styles from './SearchResultList.module.scss';
export interface SearchResultListProps { results: SearchResult[]; selected: number; query: string; onSelect: () => void }
export function SearchResultList({ results, selected, query, onSelect }: SearchResultListProps) { return <ul id="search-results" role="listbox" aria-label="Search results" className={styles.list}>{results.map((result,index) => <SearchResultItem key={`${result.href}-${index}`} result={result} index={index} selected={index === selected} query={query} onSelect={onSelect} />)}</ul>; }
