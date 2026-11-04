import type { Metadata } from 'next';
import '../../styles/globals.scss';

export const metadata: Metadata = { title: 'Framekit Documentation', description: 'Framekit documentation placeholder' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = `(function(){try{var t=localStorage.getItem('framekit-docs-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
  return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
