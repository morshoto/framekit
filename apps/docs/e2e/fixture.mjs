import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve('out');
const mount = process.env.DOCS_BASE_PATH || '';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
export const test = base.extend({
  site: [async ({}, use) => {
    const server = createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (mount && !pathname.startsWith(`${mount}/`)) throw new Error('outside mount');
        const relative = decodeURIComponent(pathname.slice(mount.length));
        let file = resolve(root, `.${relative}`);
        if (file !== root && !file.startsWith(root + sep)) throw new Error('outside export');
        if (relative.endsWith('/')) file = join(file, 'index.html');
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'text/html' }); res.end(await readFile(join(root, '404.html')));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await use(`http://127.0.0.1:${server.address().port}${mount}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }, { scope: 'worker' }],
});
export { expect };
