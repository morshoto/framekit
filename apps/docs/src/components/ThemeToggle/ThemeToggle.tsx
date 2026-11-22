'use client';
import { useEffect, useState } from 'react';
import { IconButton } from '../IconButton';
import styles from './ThemeToggle.module.scss';
export interface ThemeToggleProps { }
export function ThemeToggle(_props: ThemeToggleProps) {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const sync = () => { const value = document.documentElement.dataset.theme; setTheme(value === 'dark' || value === 'light' ? value : media?.matches ? 'dark' : 'light'); };
    sync(); media?.addEventListener('change', sync); return () => media?.removeEventListener('change', sync);
  }, []);
  const toggle = () => { const next = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('framekit-docs-theme', next); } catch {} setTheme(next); };
  return <span className={styles.toggle}><IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>{theme === 'dark' ? '☀' : '☾'}</IconButton></span>;
}
