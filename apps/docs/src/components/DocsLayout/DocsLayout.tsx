'use client';
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
export interface DocsLayoutProps { locale?: Locale; slug?: string; title: string; description?: string; groups: NavGroup[]; headings: Heading[]; activeHref?: string; previous?: NavItem; next?: NavItem; children: ReactNode }
export function DocsLayout({ locale, slug, title, description, groups, headings, activeHref, previous, next, children }: DocsLayoutProps) {
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
  return <><SiteHeader onMenu={() => setOpen(true)} onSearch={() => setSearchOpen(true)} locale={locale} slug={slug} /><div className={styles.layout}>
    <aside className={styles.sidebar} aria-label="Documentation sidebar"><DocsSidebar groups={groups} activeHref={currentHref} /></aside>
    <main id="main-content" className={styles.main}><Breadcrumbs current={title} homeHref={locale ? `/${locale}/` : "/"} /><article className={styles.article} data-pagefind-body><h1>{title}</h1>{description && <p className={styles.description}>{description}</p>}<div className={styles.mobileToc} data-pagefind-ignore><details><summary>On this page</summary><TableOfContents headings={headings} /></details></div>{children}</article><DocsPager previous={previous} next={next} /></main>
    <aside className={styles.toc} aria-label="Page contents"><TableOfContents headings={headings} /></aside>
  </div><MobileNavDrawer open={open} onClose={() => setOpen(false)}><DocsSidebar groups={groups} activeHref={currentHref} onNavigate={() => setOpen(false)} /></MobileNavDrawer><SearchDialog open={searchOpen} locale={locale || "en"} onClose={() => setSearchOpen(false)} /></>;
}
