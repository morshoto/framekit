'use client';
import { useEffect, useState } from 'react';
import styles from './FallbackNotice.module.scss';
export interface FallbackNoticeProps { message: string; fallback?: boolean }
export function FallbackNotice({ message, fallback }: FallbackNoticeProps) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setVisible(new URLSearchParams(location.search).get('fallback') === '1'); }, []);
  return (fallback ?? visible) ? <p className={styles.notice} role="status">{message}</p> : null;
}
