import { notFound } from 'next/navigation';
import { isLocale, locales } from '../../lib/i18n/locales';
import '../../styles/globals.scss';
export function generateStaticParams() { return locales.map(lang => ({ lang })); }
export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const themeScript = `(function(){try{var t=localStorage.getItem('framekit-docs-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
  return <html lang={lang} suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: themeScript }} />{children}</body></html>;
}
