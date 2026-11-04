import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { checkExportLinks } from '../scripts/check-export-links.mjs';

test('validates local asset and route links under a deployment prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-links-'));
  try {
    await mkdir(join(dir, '_next'));
    await writeFile(join(dir, '_next', 'site.css'), '');
    await writeFile(join(dir, 'index.html'), '<link href="/framekit/_next/site.css"><a href="/framekit/">Home</a><img src="_next/site.css">');
    assert.deepEqual(await checkExportLinks(dir, '/framekit'), []);
    await writeFile(join(dir, 'index.html'), '<a href="/framekit/?q=ok#part">Home</a><img srcset="/framekit/_next/site.css 1x, /framekit/missing.png 2x">');
    assert.equal((await checkExportLinks(dir, '/framekit')).length, 1);
    await writeFile(join(dir, 'index.html'), '<img srcset="data:image/png;base64,AAAA, /framekit/missing.png 2x">');
    assert.equal((await checkExportLinks(dir, '/framekit')).length, 1);
    await writeFile(join(dir, 'index.html'), '<img src="../../outside.png">');
    assert.match((await checkExportLinks(dir, '/framekit'))[0], /escapes export/);
    await writeFile(join(dir, 'index.html'), '<img src="/framekit/missing.png"><a href="/wrong/">Bad</a>');
    assert.equal((await checkExportLinks(dir, '/framekit')).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('can be imported without a script argument', () => {
  const moduleUrl = new URL('../scripts/check-export-links.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`]);
});

test('reports a missing export with the build command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-no-export-'));
  try { assert.match((await checkExportLinks(join(dir, 'out')))[0], /run.*build/i); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
