import Link from 'next/link';
import type { Locale } from '../../lib/i18n/locales';
import type { NavItem } from '../../lib/navigation';
import styles from './DocsPager.module.scss';
export interface DocsPagerProps { previous?: NavItem; next?: NavItem; locale?: Locale }
export function DocsPager({ previous, next, locale }: DocsPagerProps) { return <nav className={styles.pager} aria-label={locale === 'ja' ? 'ページナビゲーション' : 'Page navigation'}>{previous && <Link href={previous.href}>← {locale === 'ja' ? '前へ' : 'Previous'}: {previous.title}</Link>}{next && <Link href={next.href}>{locale === 'ja' ? '次へ' : 'Next'}: {next.title} →</Link>}</nav>; }
