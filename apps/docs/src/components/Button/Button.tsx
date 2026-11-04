import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.scss';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  loading?: boolean;
}

export function Button({ variant = 'primary', loading = false, disabled, type = 'button', className = '', children, ...props }: ButtonProps) {
  return <button {...props} type={type} className={`${styles.button} ${styles[variant]} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined}>{children}{loading && <span className={styles.loading}> Loading…</span>}</button>;
}
