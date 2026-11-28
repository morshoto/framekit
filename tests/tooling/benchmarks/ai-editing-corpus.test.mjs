import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadCorpus, verifyAsset } from '../../../scripts/benchmarks/ai-editing/corpus.mjs';

test('pins public real audio and annotations with explicit reference limitations', async () => {
  const corpus = await loadCorpus();
  assert.ok(corpus.assets.filter((asset) => asset.kind === 'audio').length >= 4);
  assert.ok(corpus.assets.some((asset) => asset.kind === 'annotations'));
  for (const asset of corpus.assets) {
    assert.match(asset.url, /^https:\/\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.license && asset.credit);
  }
  assert.match(corpus.referenceTiming, /automatic/i);
});

test('checks actual asset bytes and rejects missing or altered files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'framekit-corpus-'));
  try {
    const file = join(directory, 'sample');
    const bytes = Buffer.from('audio data');
    const expected = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(verifyAsset(file, expected), /ENOENT/);
    await writeFile(file, bytes);
    assert.equal(await verifyAsset(file, expected), expected);
    await writeFile(file, 'different');
    await assert.rejects(verifyAsset(file, expected), /digest/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
