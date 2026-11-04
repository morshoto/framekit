import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}

function srcsetUrls(input) {
  const urls = []; let index = 0;
  while (index < input.length) {
    while (index < input.length && /[\s,]/.test(input[index])) index++;
    const start = index;
    while (index < input.length && !/\s/.test(input[index])) index++;
    let url = input.slice(start, index);
    const trailingComma = url.endsWith(',');
    url = url.replace(/,+$/, '');
    if (url) urls.push(url);
    if (!trailingComma) { while (index < input.length && input[index] !== ',') index++; }
  }
  return urls;
}

export async function checkExportLinks(root, basePath = '') {
  root = resolve(root);
  const errors = [];
  for (const file of (await files(root)).filter(path => path.endsWith('.html'))) {
    const html = await readFile(file, 'utf8');
    const values = [];
    for (const match of html.matchAll(/\b(href|src|srcset)="([^"]+)"/g)) {
      const attribute = match[2].replaceAll('&amp;', '&');
      if (match[1] === 'srcset') {
        values.push(...srcsetUrls(attribute));
      } else values.push(attribute);
    }
    for (const value of values) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) continue;
      let pathname;
      try { pathname = decodeURIComponent(new URL(value, 'https://example.invalid/').pathname); }
      catch { errors.push(`${file}: invalid URL ${value}`); continue; }
      if (value.startsWith('/') && basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
        errors.push(`${file}: URL outside base path: ${value}`); continue;
      }
      const absolute = value.startsWith('/');
      const relative = absolute ? pathname.slice(basePath.length + 1) : decodeURIComponent(value.split(/[?#]/, 1)[0]);
      let target = resolve(absolute ? root : dirname(file), relative);
      if (target !== root && !target.startsWith(root + sep)) { errors.push(`${file}: path escapes export: ${value}`); continue; }
      try {
        if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
        if (!(await stat(target)).isFile()) throw new Error('not a file');
      } catch { errors.push(`${file}: missing ${value}`); }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../out/', import.meta.url));
  const errors = await checkExportLinks(root, process.env.DOCS_BASE_PATH || '');
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Export links resolve in ${root}`);
}
