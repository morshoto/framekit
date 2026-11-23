import type { Metadata } from 'next';
import '../../styles/globals.scss';
import { overviewMetadata } from '../../lib/docs/metadata';

export const metadata: Metadata = { ...overviewMetadata('en', process.env.DOCS_SITE_ORIGIN || 'https://morshoto.github.io', process.env.DOCS_BASE_PATH || ''), robots: { index: false, follow: true } };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = `(function(){try{var t=localStorage.getItem('framekit-docs-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
  return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
