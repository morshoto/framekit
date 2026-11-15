'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { Heading, NavGroup, NavItem } from '../../lib/navigation';
import type { Locale } from '../../lib/i18n/locales';
import { Breadcrumbs } from '../Breadcrumbs';
import { DocsPager } from '../DocsPager';
import { DocsSidebar } from '../DocsSidebar';
import { MobileNavDrawer } from '../MobileNavDrawer';
import { SiteHeader } from '../SiteHeader';
import { SearchDialog } from '../SearchDialog';
import { TableOfContents } from '../TableOfContents';
import styles from './DocsLayout.module.scss';
export interface DocsLayoutProps { locale?: Locale; slug?: string; title: string; description?: string; section?: string; status?: 'draft' | 'ready'; groups: NavGroup[]; headings: Heading[]; activeHref?: string; previous?: NavItem; next?: NavItem; landing?: boolean; customHeading?: boolean; children: ReactNode }
export function DocsLayout({ locale, slug, title, description, section, status, groups, headings, activeHref, previous, next, landing = false, customHeading = false, children }: DocsLayoutProps) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k' || target?.isContentEditable || target?.closest('input, textarea, select, [contenteditable=true]')) return;
      event.preventDefault(); setOpen(false); setSearchOpen(true);
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [currentHref, setCurrentHref] = useState(activeHref);
  useEffect(() => { const sync = () => setCurrentHref(location.hash && activeHref?.includes('#') ? `${activeHref.split('#')[0]}${location.hash}` : activeHref); sync(); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync); }, [activeHref]);
  return <><SiteHeader onMenu={() => setOpen(true)} onSearch={() => setSearchOpen(true)} locale={locale} slug={slug} /><div className={`${styles.layout} ${landing ? styles.landing : ""}`}>
    <aside className={styles.sidebar} aria-label="Documentation sidebar"><DocsSidebar groups={groups} activeHref={currentHref} /></aside>
    <main id="main-content" className={styles.main}>{!landing && <Breadcrumbs section={section} current={title} homeHref={locale ? `/${locale}/` : "/"} />}<article className={styles.article} {...(status === 'draft' ? { 'data-pagefind-ignore': true } : { 'data-pagefind-body': true })}>{!customHeading && <h1>{title}</h1>}{status === 'draft' && <p role="status">{locale === 'ja' ? '日本語版は準備中です。内容をご覧になるには英語版をご利用ください。' : 'Placeholder: this page is not yet complete.'}{locale === 'ja' && slug && <> <Link href={`/en/docs/${slug}/`}>英語版を読む</Link></>}</p>}{description && <p className={styles.description}>{description}</p>}{!landing && headings.length > 0 && <div className={styles.mobileToc} data-pagefind-ignore><details><summary>{locale === 'ja' ? 'このページの内容' : 'On this page'}</summary><TableOfContents headings={headings} locale={locale} /></details></div>}{children}</article><DocsPager previous={previous} next={next} locale={locale} /></main>
    {!landing && headings.length > 0 && <aside className={styles.toc} aria-label="Page contents"><TableOfContents headings={headings} locale={locale} /></aside>}
  </div><MobileNavDrawer open={open} onClose={() => setOpen(false)}><DocsSidebar groups={groups} activeHref={currentHref} onNavigate={() => setOpen(false)} /></MobileNavDrawer><SearchDialog open={searchOpen} locale={locale || "en"} onClose={() => setSearchOpen(false)} /></>;
}
