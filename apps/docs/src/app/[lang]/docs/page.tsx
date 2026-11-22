import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export function generateStaticParams() { return [{ lang: 'en' }]; }
export const metadata: Metadata = { robots: { index: false, follow: true }, alternates: { canonical: `${process.env.DOCS_BASE_PATH || ''}/en/docs/introduction/` } };
export default async function DocsIndex({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (lang !== 'en') notFound();
  const destination = `${process.env.DOCS_BASE_PATH || ''}/en/docs/introduction/`;
  return <><meta httpEquiv="refresh" content={`0;url=${destination}`} /><p>Redirecting to <a href={destination}>Introduction</a>.</p></>;
}
