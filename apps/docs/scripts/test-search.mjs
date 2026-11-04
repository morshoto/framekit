import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve('out'); const base = process.env.DOCS_BASE_PATH || '';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.txt':'text/plain', '.wasm':'application/wasm' };
const server = createServer(async (req,res) => {
  try { const url = new URL(req.url,'http://localhost'); if (base && !url.pathname.startsWith(`${base}/`)) throw new Error(); const pathname=decodeURIComponent(url.pathname.slice(base.length)); let file=resolve(root, `.${pathname}`); if(file!==root&&!file.startsWith(root+sep)) throw new Error(); if(pathname.endsWith('/')) file=join(file,'index.html'); const data=await readFile(file); res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'}); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); let browser;
try {
  browser=await chromium.launch({executablePath:process.env.STORYBOOK_CHROMIUM_PATH||undefined}); const origin=`http://127.0.0.1:${server.address().port}`; await mkdir('artifacts/search',{recursive:true});
  for (const [locale, query, title] of [['en','lantern','Introduction'], ['ja','ランタン','はじめに']]) {
    const page=await browser.newPage({viewport:{width:375,height:800}}); const errors=[];
    page.on('pageerror',error=>errors.push(error.message)); page.on('response',response=>{if(response.url().startsWith(origin) && response.status()>=400) errors.push(`${response.status()} ${response.url()}`);});
    await page.goto(`${origin}${base}/${locale}/docs/examples/`,{waitUntil:'networkidle'});
    const trigger=page.getByRole('button',{name:'Search docs'}); await trigger.click();
    const input=page.getByRole('combobox',{name:'Search documentation'}); assert.equal(await input.evaluate(el=>document.activeElement===el),true);
    await input.fill(query); const result=page.getByRole('option').filter({hasText:title}).first(); await result.waitFor();
    assert.ok((await result.getByRole('link').getAttribute('href')).startsWith(`${base}/${locale}/docs/introduction`));
    await page.screenshot({path:`artifacts/search/${locale}.png`});
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(),0); assert.equal(await trigger.evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Control+k'); await page.getByRole('combobox').fill(query); await page.getByRole('option').filter({hasText:title}).first().waitFor();
    await page.keyboard.press('Enter'); await page.waitForURL(`**${base}/${locale}/docs/introduction/`); await page.reload({waitUntil:'networkidle'});
    if (locale === 'en') {
      await page.getByRole('link', { name:'日本語' }).click(); await page.waitForURL(`**${base}/ja/docs/introduction/`);
      await page.getByRole('button', { name:'Search docs' }).click(); await page.getByRole('combobox').fill('ランタン');
      await page.getByRole('option').filter({hasText:'はじめに'}).first().waitFor();
      for (const link of await page.getByRole('option').getByRole('link').all()) assert.ok((await link.getAttribute('href')).startsWith(`${base}/ja/`));
    }
    assert.deepEqual(errors,[]); await page.close();
  }
  const page=await browser.newPage(); await page.route('**/pagefind/**',route=>route.abort());
  await page.goto(`${origin}${base}/en/docs/introduction/`,{waitUntil:'networkidle'}); await page.getByRole('button',{name:'Search docs'}).click(); await page.getByRole('combobox').fill('lantern'); await page.getByRole('link',{name:'Browse docs'}).waitFor(); await page.close();
  const noJs=await browser.newPage({javaScriptEnabled:false}); await noJs.goto(`${origin}${base}/en/docs/introduction/`); assert.ok(await noJs.getByRole('heading',{name:'Overview'}).count()); await noJs.close();
  console.log(`Search browser checks passed at ${base||'(root)'}`);
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
