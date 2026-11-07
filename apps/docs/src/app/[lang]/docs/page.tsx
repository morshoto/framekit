import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EnglishOverview } from '../../../components/EnglishOverview';
export function generateStaticParams() { return [{ lang: 'en' }]; }
export const metadata: Metadata = { title: 'Framekit Documentation', description: 'Build and inspect video editing workflows with Framekit.', alternates: { canonical: `${process.env.DOCS_BASE_PATH || ''}/en/` } };
export default async function DocsIndex({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (lang !== 'en') notFound();
  return <EnglishOverview />;
}
