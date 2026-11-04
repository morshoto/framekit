import Link from 'next/link';
import { localeTarget } from '../../lib/docs/source';
import type { Locale } from '../../lib/i18n/locales';
import styles from './LanguageSwitcher.module.scss';
export interface LanguageSwitcherProps { locale: Locale; slug?: string }
export function LanguageSwitcher({ locale, slug }: LanguageSwitcherProps) {
  const target = locale === 'en' ? 'ja' : 'en'; const destination = localeTarget(target, slug);
  return <Link className={styles.link} href={destination.fallback ? `${destination.href}?fallback=1` : destination.href} hrefLang={target} aria-label={`${target === 'ja' ? '日本語' : 'English'}${destination.fallback ? ' (overview fallback)' : ''}`}>{target === 'ja' ? '日本語' : 'EN'}</Link>;
}
