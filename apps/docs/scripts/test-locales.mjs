import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve('out'); const base = process.env.DOCS_BASE_PATH || '';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.txt':'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); if (base && !url.pathname.startsWith(`${base}/`)) throw new Error('wrong mount');
    const pathname = decodeURIComponent(url.pathname.slice(base.length)); let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('invalid path');
    if (pathname.endsWith('/')) file = join(file, 'index.html');
    const data = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/html' }); res.end(await readFile(join(root, '404.html'))); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.STORYBOOK_CHROMIUM_PATH || undefined });
  const origin = `http://127.0.0.1:${server.address().port}`; await mkdir('artifacts/locales', { recursive: true });
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport:{width,height:900} }); const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().startsWith(origin + base + '/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    for (const lang of ['en', 'ja']) for (const slug of ['introduction', 'getting-started', 'examples']) {
      await page.goto(`${origin}${base}/${lang}/docs/${slug}/`, { waitUntil:'networkidle' });
      assert.equal(await page.locator('html').getAttribute('lang'), lang);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${lang}/${slug} overflow at ${width}`);
      await page.reload({ waitUntil:'networkidle' });
    }
    await page.goto(`${origin}${base}/`, { waitUntil:'networkidle' });
    await page.getByRole('link', { name:'Read the English introduction' }).click();
    await page.waitForURL(`**${base}/en/docs/introduction/`);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.goto(`${origin}${base}/en/docs/getting-started/`, { waitUntil:'networkidle' });
    await page.getByRole('button', { name:'Copy code' }).first().click();
    await page.getByText('Copied', { exact:true }).waitFor();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('printf'));
    await page.goto(`${origin}${base}/en/docs/introduction/`, { waitUntil:'networkidle' });
    await page.getByRole('link', {name:'日本語'}).click(); await page.waitForURL(`**${base}/ja/docs/introduction/`);
    assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
    await page.getByRole('link', {name:'English', exact: true}).click(); await page.waitForURL(`**${base}/en/docs/introduction/`);
    await page.goBack(); await page.waitForURL(`**${base}/ja/docs/introduction/`);
    await page.goForward(); await page.waitForURL(`**${base}/en/docs/introduction/`);
    await page.getByRole('link', {name:'日本語'}).click(); await page.waitForURL(`**${base}/ja/docs/introduction/`);
    await page.screenshot({ path:`artifacts/locales/ja-${width}.png` });
    assert.deepEqual(errors, []); await page.close();
  }
  const missing = await browser.newPage();
  const response = await missing.goto(`${origin}${base}/ja/docs/not-real/`);
  assert.equal(response?.status(), 404); assert.equal(await missing.getByRole('heading', {name:'Page not found'}).count(), 1);
  await missing.close();
  console.log(`Locale browser checks passed at base path ${base || '(root)'}`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
