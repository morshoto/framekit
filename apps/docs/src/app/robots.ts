import { robotsContent, siteUrl } from '../lib/docs/sitemap';

export const dynamic = 'force-static';
export default function robots() { return robotsContent(siteUrl); }
