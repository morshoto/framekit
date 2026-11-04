import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContentLinks } from '../scripts/check-content-links.mjs';
test('rejects broken routes, anchors and assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-content-'));
  try {
    const content = join(dir, 'content'); const pub = join(dir, 'public');
    await mkdir(join(content, 'en'), { recursive: true }); await mkdir(join(content, 'ja'), { recursive: true }); await mkdir(pub);
    await writeFile(join(content, 'en', 'one.mdx'), '## Section\n[ok](#section)\n[bad](#missing)\n[page](/en/docs/nope/)\n![image](/images/nope.svg)\n[ref][missing]\n\n[missing]: /en/docs/absent/');
    assert.equal((await checkContentLinks(content, pub)).length, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('validates literal MDX JSX links and rejects dynamic destinations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-mdx-links-'));
  try {
    const content = join(dir, 'content'); const pub = join(dir, 'public');
    await mkdir(join(content, 'en'), { recursive:true }); await mkdir(join(content, 'ja'), { recursive:true }); await mkdir(pub);
    await writeFile(join(content, 'en', 'one.mdx'), '## Heading\n\n<a href="/en/docs/missing/">Broken</a>\n\n<img src="/images/missing.svg" alt="sample" />\n\n<a href={target}>Dynamic</a>\n\n<img src="/images/missing.svg" srcSet="/images/other.svg 2x" alt="sample" />');
    const errors = await checkContentLinks(content, pub);
    assert.equal(errors.length, 5);
    assert.ok(errors.some(error => error.includes('srcSet cannot be checked')));
  } finally { await rm(dir, { recursive:true, force:true }); }
});
