'use client';
import { useEffect, useState } from 'react';
import type { Heading } from '../../lib/navigation';
import styles from './TableOfContents.module.scss';
export interface TableOfContentsProps { headings: Heading[] }
export function TableOfContents({ headings }: TableOfContentsProps) {
  const [active, setActive] = useState('');
  useEffect(() => {
    const updateHash = () => { try { setActive(decodeURIComponent(location.hash.slice(1))); } catch { setActive(''); } };
    updateHash(); window.addEventListener('hashchange', updateHash);
    if (!('IntersectionObserver' in window)) return () => window.removeEventListener('hashchange', updateHash);
    const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id); }, { rootMargin: '-64px 0px -70% 0px' });
    headings.forEach(heading => { const element = document.getElementById(heading.id); if (element) observer.observe(element); });
    return () => { observer.disconnect(); window.removeEventListener('hashchange', updateHash); };
  }, [headings]);
  return <nav className={styles.toc} aria-label="On this page"><p>On this page</p><ul>{headings.map(heading => <li key={heading.id}><a href={`#${heading.id}`} aria-current={active === heading.id ? 'location' : undefined}>{heading.title}</a></li>)}</ul></nav>;
}
