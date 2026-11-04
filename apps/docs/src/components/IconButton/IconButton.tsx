import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.scss';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
  children: ReactNode;
  variant?: 'plain' | 'outlined';
}
export function IconButton({ label, children, variant = 'plain', type = 'button', className = '', ...props }: IconButtonProps) {
  if (!label.trim()) throw new Error('IconButton requires a nonempty label');
  return <button {...props} type={type} aria-label={label} className={`${styles.button} ${styles[variant]} ${className}`}><span aria-hidden="true">{children}</span></button>;
}
