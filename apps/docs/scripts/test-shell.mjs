import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('out');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    let path = resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) throw new Error('invalid path');
    if (path === root || req.url.split('?')[0].endsWith('/')) path = join(path, 'index.html');
    const data = await readFile(path); res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.STORYBOOK_CHROMIUM_PATH || undefined });
  await mkdir('artifacts/shell', { recursive: true });
  for (const width of [320, 375, 393, 767, 768, 1024, 1199, 1200, 1280, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    assert.equal(await page.locator('aside[aria-label="Documentation sidebar"]').isVisible(), false, `landing sidebar at ${width}`);
    if (width < 768) {
      const trigger = page.getByRole('button', { name: 'Open navigation' }); await trigger.click();
      await page.getByRole('dialog', { name: 'Documentation navigation' }).waitFor();
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    }
    assert.deepEqual(errors, []); await page.screenshot({ path: `artifacts/shell/${width}.png` }); await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 375, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(16, 18, 22)');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('framekit-docs-theme')), 'light');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click(); await page.getByRole('dialog').getByRole('link', { name: 'Fixture setup' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await page.close();
  const touch = await browser.newPage({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  await touch.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await touch.getByRole('button', { name: 'Open navigation' }).tap();
  await touch.getByRole('dialog', { name: 'Documentation navigation' }).waitFor();
  await touch.getByRole('button', { name: 'Close navigation' }).tap();
  assert.equal(await touch.getByRole('dialog').count(), 0);
  await touch.close();
  console.log('Responsive shell checks passed');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
