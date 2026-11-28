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

test('extracts timed words from AMI annotations as unverified screening evidence', async () => {
  const { parseAmiWords } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const xml = `<nite:root xmlns:nite="urn:nite"><w starttime="0.5" endtime="0.8">hello</w><w starttime="0.8" endtime="0.8">.</w><w starttime="2" endtime="3">quiet &amp; clear</w></nite:root>`;
  assert.deepEqual(await parseAmiWords(xml, 'A'), [
    { start: 0.5, end: 0.8, text: 'hello', speaker: 'A', verification: 'automatic-alignment' },
    { start: 2, end: 3, text: 'quiet & clear', speaker: 'A', verification: 'automatic-alignment' },
  ]);
  await assert.rejects(parseAmiWords('<wrong/>', 'A'), /annotation/i);
  await assert.rejects(parseAmiWords('<nite:root><w starttime="bad" endtime="2">oops</w></nite:root>', 'A'), /timing/i);
});

test('compares chunk-relative proposals with source-relative reference words', async () => {
  const { screenAlignedCuts } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const result = screenAlignedCuts([{sourceRange: {start: 1, end: 2}}], 60, [
    {start: 61.5, end: 62.5, text: 'word', speaker: 'A', verification: 'automatic-alignment'},
    {start: 62, end: 63, text: 'next', speaker: 'B', verification: 'automatic-alignment'},
  ]);
  assert.equal(result[0].start, 61);
  assert.equal(result[0].end, 62);
  assert.deepEqual(result[0].overlaps.map((word) => word.text), ['word']);
  assert.throws(() => screenAlignedCuts([{sourceRange: {start: 2, end: 1}}], 60, []), /range/i);
  assert.throws(() => screenAlignedCuts([{}], 60, []), /Invalid candidate range/);
  assert.throws(() => screenAlignedCuts([null], 60, []), /Invalid candidate range/);
});

test('runner rejects unknown recordings and out-of-corpus windows before invoking providers', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-ami.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const invoke = (id, start) => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(runner), '/missing', id, start, 'python'], {encoding: 'utf8', stdio: 'pipe'});
  assert.throws(() => invoke('unknown', '0'), /unknown corpus audio/i);
  assert.throws(() => invoke('EN2002a', '600'), /outside corpus/i);
  assert.throws(() => invoke('EN2002a', '0.1'), /60-second/i);
});
test('production cut screening requires reviewable read-only previews', async () => {
  const { summarizeProductionCutPreviews } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const cut={index:0,candidate:{sourceRange:{start:1,end:2},reviewRequired:true,confidence:0.5,evidence:['speech']}};
  assert.equal(summarizeProductionCutPreviews([],[],60).status,'unavailable');
  assert.throws(()=>summarizeProductionCutPreviews([cut],[{index:0,scope:'approved'}],60),/preview/i);
  assert.throws(()=>summarizeProductionCutPreviews([{...cut,candidate:{...cut.candidate,reviewRequired:false}}],[{index:0,scope:'headless-preview'}],60),/review/i);
  const result=summarizeProductionCutPreviews([cut],[{index:0,scope:'headless-preview'}],60);
  assert.deepEqual(result.candidates[0].sourceRange,{start:61,end:62});
  assert.equal(result.speechSafety,'unverified');
});

test('headless probes preserve PATH commands and isolate native-provider settings', async () => {
  const { resolveProbeCommand, headlessProbeEnvironment } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const { resolve, join } = await import('node:path');
  assert.equal(resolveProbeCommand('python3'), 'python3');
  assert.equal(resolveProbeCommand('./venv/python'), resolve('./venv/python'));
  assert.equal(resolveProbeCommand('/usr/bin/python3'), '/usr/bin/python3');
  const input={FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER:'native',FRAMEKIT_FINAL_CUT_NATIVE_WRITES:'1',PATH:'/bin'};
  const env=headlessProbeEnvironment(input,'/tmp/probe');
  assert.equal(env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER,'');
  assert.equal(env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES,'0');
  assert.equal(env.FRAMEKIT_FINAL_CUT_HEADLESS,'1');
  assert.equal(env.FRAMEKIT_STATE_DIR,join('/tmp/probe','state'));
  assert.equal(input.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER,'native');
});

test('editorial subset validates pinned revision and row before accepting audio', async () => {
  const { editorialAssetUrl } = await import('../../../scripts/benchmarks/ai-editing/editorial-subset.mjs');
  const item = { dataset: 'example/speech', revision: 'a'.repeat(40), config: 'default', split: 'train', row: 3, sha256: 'b'.repeat(64), filename: 'sample.wav' };
  const url = `https://datasets-server.huggingface.co/cached-assets/example/speech/--/${item.revision}/--/default/train/3/audio/audio.wav?signature=example`;
  assert.equal(editorialAssetUrl({ rows: [{ row_idx: 3, row: { audio: [{ src: url }] } }] }, item), url);
  assert.throws(() => editorialAssetUrl({ rows: [{ row_idx: 4, row: { audio: [{ src: url }] } }] }, item), /row/i);
  assert.throws(() => editorialAssetUrl({ rows: [{ row_idx: 3, row: { audio: [{ src: url.replace(item.revision, 'c'.repeat(40)) }] } }] }, item), /revision/i);
  assert.throws(() => editorialAssetUrl({ rows: [{ row_idx: 3, row: { audio: [{ src: url.replace('datasets-server.huggingface.co', 'example.com') }] } }] }, item), /host/i);
});

test('editorial downloader rejects changed bytes before writing audio', async () => {
  const { downloadEditorialSubset } = await import('../../../scripts/benchmarks/ai-editing/editorial-subset.mjs');
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../scripts/benchmarks/ai-editing/editorial-subset.json', import.meta.url), 'utf8'));
  const item = manifest.items[0];
  const parent = await mkdtemp(join(tmpdir(), 'framekit-editorial-'));
  const output = join(parent, 'new');
  const asset = `https://datasets-server.huggingface.co/cached-assets/${item.dataset}/--/${item.revision}/--/${item.config}/${item.split}/${item.row}/audio/audio.wav`;
  const fakeFetch = async (url) => url.includes('/rows?')
    ? {ok:true,json:async()=>({rows:[{row_idx:item.row,row:{audio:[{src:asset}]}}]})}
    : {ok:true,arrayBuffer:async()=>Buffer.from('changed audio')};
  try {
    await assert.rejects(downloadEditorialSubset(output, fakeFetch), /digest mismatch/i);
    await assert.rejects((await import('node:fs/promises')).access(join(output,item.filename)), /ENOENT/);
  } finally { await rm(parent, {recursive:true,force:true}); }
});

test('editorial downloader accepts new nested output but rejects an existing directory', async () => {
  const { downloadEditorialSubset } = await import('../../../scripts/benchmarks/ai-editing/editorial-subset.mjs');
  const parent = await mkdtemp(join(tmpdir(), 'framekit-editorial-nested-'));
  const output = join(parent, 'nested', 'new');
  const failFetch = async () => ({ok:false,status:503});
  try {
    await assert.rejects(downloadEditorialSubset(output, failFetch), /request failed: 503/);
    await assert.rejects(downloadEditorialSubset(output, failFetch), /EEXIST/);
  } finally { await rm(parent, {recursive:true,force:true}); }
});
