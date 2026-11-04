'use client';
import { useState } from 'react';
import styles from './CodeBlock.module.scss';
export interface CodeBlockProps { code: string; language?: string }
export function CodeBlock({ code, language }: CodeBlockProps) {
  const [status, setStatus] = useState('');
  async function copy() { try { await navigator.clipboard.writeText(code); setStatus('Copied'); } catch { setStatus('Copy unavailable'); } }
  return <div className={styles.block}><div className={styles.bar}><span>{language || 'text'}</span><button type="button" onClick={copy}>Copy code</button></div><pre><code>{code}</code></pre><span className={styles.status} role="status">{status}</span></div>;
}
