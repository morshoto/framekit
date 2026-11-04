import type { Metadata } from 'next';
import '../styles/globals.scss';

export const metadata: Metadata = { title: 'Framekit Documentation', description: 'Framekit documentation placeholder' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
