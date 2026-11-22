'use client';
import { useState, type ReactNode } from 'react';
import { Prism } from 'prism-react-renderer';
import styles from './CodeBlock.module.scss';

export interface CodeBlockProps { code: string; language?: string; title?: string }

function renderToken(token: string | Prism.Token, key: number): ReactNode {
  if (typeof token === 'string') return token;
  const content = Array.isArray(token.content)
    ? token.content.map(renderToken)
    : typeof token.content === 'string' ? token.content : renderToken(token.content, 0);
  return <span key={key} className={styles[token.type]}>{content}</span>;
}

export function CodeBlock({ code, language, title }: CodeBlockProps) {
  const [status, setStatus] = useState('');
  const grammar = language && Prism.languages[language];
  const label = title || (['sh', 'bash', 'shell'].includes(language || '') ? 'Terminal' : language || 'text');
  async function copy() { try { await navigator.clipboard.writeText(code); setStatus('Copied'); } catch { setStatus('Copy unavailable'); } }
  return <div className={styles.block}><div className={styles.bar}><span>{label}</span><button type="button" onClick={copy}>Copy code</button></div><pre role="region" aria-label="Code snippet" tabIndex={0}><code>{grammar ? Prism.tokenize(code, grammar).map(renderToken) : code}</code></pre><span className={styles.status} role="status">{status}</span></div>;
}
