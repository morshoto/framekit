import { readFileSync } from 'node:fs';
import { documents } from '../src/lib/docs/source';
import { checkSitemap } from '../src/lib/docs/sitemap-check';
import { siteUrl } from '../src/lib/docs/sitemap';

checkSitemap(readFileSync('out/sitemap.xml', 'utf8'), documents, siteUrl);
const robots = readFileSync('out/robots.txt', 'utf8');
if (!robots.includes(`Sitemap: ${siteUrl}/sitemap.xml`)) throw new Error('Missing sitemap directive in robots.txt');
console.log('Sitemap and robots.txt match the documentation registry.');
