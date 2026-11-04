import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('storybook-static');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    if (!path.startsWith(root + sep)) throw new Error('invalid path');
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.STORYBOOK_CHROMIUM_PATH || undefined });
  await mkdir('artifacts/storybook', { recursive: true });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 320, height: 500 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/iframe.html?id=controls-button--primary&viewMode=story&globals=theme:${theme}`, { waitUntil: 'networkidle' });
    const button = page.getByRole('button', { name: 'Continue' });
    await button.waitFor();
    const box = await button.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, 'touch target');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `artifacts/storybook/${theme}-320.png` });
    await page.close();
  }
  console.log('Storybook light/dark browser smoke passed');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
