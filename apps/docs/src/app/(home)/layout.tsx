import type { Metadata } from 'next';
import '../../styles/globals.scss';

export const metadata: Metadata = { title: 'Framekit Documentation', description: 'Build and inspect video editing workflows with Framekit.', alternates: { canonical: `${process.env.DOCS_BASE_PATH || ''}/en/` } };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = `(function(){try{var t=localStorage.getItem('framekit-docs-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
  return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
