import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const root = resolve('out'); const base = process.env.DOCS_BASE_PATH || '';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.txt':'text/plain', '.wasm':'application/wasm' };
const server = createServer(async (req,res) => {
  try { const url = new URL(req.url,'http://localhost'); if (base && !url.pathname.startsWith(`${base}/`)) throw new Error(); const pathname=decodeURIComponent(url.pathname.slice(base.length)); let file=resolve(root, `.${pathname}`); if(file!==root&&!file.startsWith(root+sep)) throw new Error(); if(pathname.endsWith('/')) file=join(file,'index.html'); const data=await readFile(file); res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'}); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); let browser;
try {
  browser=await chromium.launch({executablePath:process.env.STORYBOOK_CHROMIUM_PATH||undefined}); const origin=`http://127.0.0.1:${server.address().port}`; await mkdir('artifacts/search',{recursive:true});
  for (const [locale, query, title] of [['en','local-first','Introduction']]) for (const colorScheme of ['light', 'dark']) {
    const context=await browser.newContext({viewport:{width:375,height:800}, colorScheme}); const page=await context.newPage(); const errors=[];
    page.on('pageerror',error=>errors.push(error.message)); page.on('response',response=>{if(response.url().startsWith(origin) && response.status()>=400) errors.push(`${response.status()} ${response.url()}`);});
    await page.goto(`${origin}${base}/${locale}/docs/examples/`,{waitUntil:'networkidle'});
    const trigger=page.getByRole('button',{name:'Search docs'}); await trigger.click();
    const input=page.getByRole('combobox',{name:'Search documentation'}); assert.equal(await input.evaluate(el=>document.activeElement===el),true);
    await input.fill(query); const result=page.getByRole('option').filter({hasText:title}).first(); await result.waitFor();
    assert.ok((await result.getAttribute('href')).startsWith(`${base}/${locale}/docs/introduction`));
    const axe = await new AxeBuilder({ page }).include('[role=dialog]').analyze();
    if (axe.violations.length) console.error(JSON.stringify(axe.violations.map(item => ({id:item.id, nodes:item.nodes.map(node => ({html:node.html, summary:node.failureSummary}))})), null, 2));
    assert.deepEqual(axe.violations.map(item => ({ id:item.id, impact:item.impact })), []);
    await page.screenshot({path:`artifacts/search/${locale}-${colorScheme}.png`});
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(),0); assert.equal(await trigger.evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Control+k'); await page.getByRole('combobox').fill(query); await page.getByRole('option').filter({hasText:title}).first().waitFor();
    await page.getByRole('option').filter({hasText:title}).first().click(); await page.waitForURL(`**${base}/${locale}/docs/introduction/`); await page.reload({waitUntil:'networkidle'});
    if (locale === 'en') {
      await page.getByRole('link', { name:'日本語' }).click(); await page.waitForURL(`**${base}/ja/docs/introduction/`);
      await page.getByRole('button', { name:'Search docs' }).click(); await page.getByRole('combobox').fill('ランタン');
      await page.getByText('No results found.').waitFor();
    }
    assert.deepEqual(errors,[]); await context.close();
  }
  {
    const page = await browser.newPage();
    await page.goto(`${origin}${base}/en/docs/introduction/`, { waitUntil:'networkidle' });
    await page.getByRole('button', { name:'Search docs' }).click();
    await page.getByRole('combobox').fill('HEADLESS_ROUGH_CUT_HISTORY_UNCONFIRMED');
    const result = page.locator('[role=option][href*="/en/docs/error-reference/"]').first();
    await result.waitFor();
    assert.ok((await result.getAttribute('href')).includes('/en/docs/error-reference/'));
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    await page.goto(`${origin}${base}/en/docs/editing-capabilities/`, { waitUntil:'networkidle' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'capability guide overflows mobile viewport');
    const matrix = page.getByRole('region', { name: 'Editing capability comparison' });
    assert.equal(await matrix.getAttribute('tabindex'), '0');
    assert.equal(await matrix.evaluate(el => el.scrollWidth > el.clientWidth), true, 'matrix should scroll on mobile');
    assert.ok(await page.locator('table th').first().evaluate(el => el.getBoundingClientRect().width >= 120), 'matrix columns must remain readable');
    await matrix.focus();
    await page.keyboard.press('End');
    assert.ok(await matrix.evaluate(el => el.scrollLeft > 0), 'matrix must support keyboard scrolling');
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.goto(`${origin}${base}/`);
    await page.waitForURL(`${origin}${base}/en/`);
    await page.goto(`${origin}${base}/en/docs/`);
    await page.waitForURL(`${origin}${base}/en/docs/introduction/`);
    await page.goto(`${origin}${base}/en/`, {waitUntil:'networkidle'});
    await page.getByRole('button', {name:'Search docs'}).click();
    await page.getByRole('combobox').fill('render');
    await page.getByRole('option').first().waitFor();
    const hrefs = await page.getByRole('option').evaluateAll(options => options.map(option => new URL(option.href).pathname));
    assert.equal(hrefs.filter(href => href === `${base}/en/`).length, 1);
    assert.ok(!hrefs.includes(`${base}/`) && !hrefs.includes(`${base}/en/docs/`));
    await page.close();
  }
  for (const colorScheme of ['light', 'dark']) {
    const offline=await browser.newContext({colorScheme}); const page=await offline.newPage(); await page.route('**/pagefind/**',route=>route.abort());
    await page.goto(`${origin}${base}/en/docs/introduction/`,{waitUntil:'networkidle'}); await page.getByRole('button',{name:'Search docs'}).click(); await page.getByRole('combobox').fill('Framekit'); await page.getByRole('link',{name:'Browse docs'}).waitFor(); const offlineAxe = await new AxeBuilder({ page }).include('[role=dialog]').analyze(); assert.deepEqual(offlineAxe.violations.map(item => item.id), []); await offline.close();
  }
  const noJs=await browser.newPage({javaScriptEnabled:false}); await noJs.goto(`${origin}${base}/en/docs/introduction/`); assert.ok(await noJs.getByRole('heading',{name:'What is Framekit?'}).count()); await noJs.close();
  console.log(`Search browser checks passed at ${base||'(root)'}`);
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
