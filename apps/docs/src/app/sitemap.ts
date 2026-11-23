import { documents } from '../lib/docs/source';
import { sitemapEntries, siteUrl } from '../lib/docs/sitemap';

export const dynamic = 'force-static';
export default function sitemap() { return sitemapEntries(documents, siteUrl); }
