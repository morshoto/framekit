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
