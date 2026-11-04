import styles from './EmptySearchState.module.scss';
export interface EmptySearchStateProps { message: string }
export function EmptySearchState({ message }: EmptySearchStateProps) { return <p className={styles.state}>{message}</p>; }
