import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { toString } from 'mdast-util-to-string';
import GithubSlugger from 'github-slugger';

function walk(node, visit) { visit(node); for (const child of node.children || []) walk(child, visit); }
export async function checkContentLinks(contentRoot, publicRoot) {
  const pages = new Map(); const errors = [];
  for (const locale of ['en', 'ja']) {
    const dir = join(contentRoot, locale);
    for (const name of (await readdir(dir)).filter(name => name.endsWith('.mdx'))) {
      const route = `/${locale}/docs/${name.slice(0, -4)}/`;
      const tree = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).parse(await readFile(join(dir, name), 'utf8'));
      const slugger = new GithubSlugger(); const anchors = new Set(); const links = []; const definitions = new Map();
      walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url); });
      walk(tree, node => {
        if (node.type === 'heading') anchors.add(slugger.slug(toString(node)));
        if ((node.type === 'image' || node.type === 'imageReference') && !node.alt?.trim()) errors.push(`${route}: image requires alt text`);
        if (node.type === 'link' || node.type === 'image') links.push({ url: node.url, image: node.type === 'image' });
        if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && ['a', 'Link', 'img', 'Image'].includes(node.name)) {
          const image = node.name === 'img' || node.name === 'Image';
          const attr = node.attributes.find(attribute => attribute.type === 'mdxJsxAttribute' && attribute.name === (image ? 'src' : 'href'));
          const alt = node.attributes.find(attribute => attribute.type === 'mdxJsxAttribute' && attribute.name === 'alt');
          if (image && node.attributes.some(attribute => attribute.type === 'mdxJsxAttribute' && (attribute.name === 'srcSet' || attribute.name === 'srcset'))) errors.push(`${route}: JSX srcSet cannot be checked; use a single local image`);
          if (node.attributes.some(attribute => attribute.type !== 'mdxJsxAttribute') || !attr || typeof attr.value !== 'string') errors.push(`${route}: dynamic or missing ${image ? 'src' : 'href'} cannot be checked`);
          else links.push({ url: attr.value, image });
          if (image && (!alt || typeof alt.value !== 'string' || !alt.value.trim())) errors.push(`${route}: image requires alt text`);
        }
        if (node.type === 'linkReference' || node.type === 'imageReference') {
          const url = definitions.get(node.identifier.toLowerCase());
          if (url) links.push({ url, image: node.type === 'imageReference' });
          else errors.push(`${route}: unresolved reference ${node.identifier}`);
        }
      });
      pages.set(route, { anchors, links });
    }
  }
  const root = resolve(publicRoot);
  for (const [route, page] of pages) for (const { url, image } of page.links) {
    let target; try { target = new URL(url, `https://framekit.invalid${route}`); } catch { errors.push(`${route}: invalid URL ${url}`); continue; }
    if (target.origin !== 'https://framekit.invalid') { if (!['https:', 'http:', 'mailto:'].includes(target.protocol)) errors.push(`${route}: unsupported URL ${url}`); continue; }
    let pathname, fragment; try { pathname = decodeURIComponent(target.pathname); fragment = decodeURIComponent(target.hash.slice(1)); } catch { errors.push(`${route}: invalid encoding ${url}`); continue; }
    if (image || pathname.startsWith('/images/')) {
      const file = resolve(root, `.${pathname}`);
      try { if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error(); } catch { errors.push(`${route}: missing asset ${url}`); }
      continue;
    }
    if (pathname === '/' || pathname === '/en/' || pathname === '/ja/') { if (fragment) errors.push(`${route}: unknown anchor ${url}`); continue; }
    const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`; const destination = pages.get(normalized);
    if (!destination) errors.push(`${route}: missing page ${url}`);
    else if (fragment && !destination.anchors.has(fragment)) errors.push(`${route}: missing anchor ${url}`);
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const errors = await checkContentLinks(join(root, 'content/docs'), join(root, 'public'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log('Mock content links and anchors resolve.');
}
