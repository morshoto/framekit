// Fetch only pinned dataset-server rows into a new disposable output directory.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function editorialAssetUrl(payload, item) {
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length !== 1 || payload.rows[0]?.row_idx !== item.row) throw new Error('Dataset row mismatch');
  const assets = payload.rows[0]?.row?.audio;
  if (!Array.isArray(assets) || assets.length !== 1 || typeof assets[0]?.src !== 'string') throw new Error('Dataset audio unavailable');
  const value = assets[0].src;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'datasets-server.huggingface.co') throw new Error('Dataset asset host mismatch');
  const expected = `/cached-assets/${item.dataset}/--/${item.revision}/--/${item.config}/${item.split}/${item.row}/audio/`;
  if (!url.pathname.startsWith(expected)) throw new Error('Dataset revision or asset path mismatch');
  return value;
}

export async function downloadEditorialSubset(output, fetcher = fetch) {
  const manifest = JSON.parse(await readFile(new URL('./editorial-subset.json', import.meta.url), 'utf8'));
  await mkdir(output);
  const saved = [];
  for (const item of manifest.items) {
    const params = new URLSearchParams({dataset:item.dataset,config:item.config,split:item.split,offset:String(item.row),length:'1'});
    const response = await fetcher(`https://datasets-server.huggingface.co/rows?${params}`);
    if (!response.ok) throw new Error(`Dataset row request failed: ${response.status}`);
    const payload = await response.json();
    const audio = await fetcher(editorialAssetUrl(payload, item));
    if (!audio.ok) throw new Error(`Dataset audio request failed: ${audio.status}`);
    const bytes = Buffer.from(await audio.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Dataset audio digest mismatch: ${item.filename}`);
    await writeFile(join(output, item.filename), bytes, {flag:'wx'});
    const {audio: _audio, ...reference} = payload.rows[0].row;
    saved.push({...item, reference});
  }
  await writeFile(join(output, 'references.json'), `${JSON.stringify({version:1, datasets:manifest.datasets, samples:saved}, null, 2)}\n`, {flag:'wx'});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3) throw new Error('Usage: node editorial-subset.mjs NEW_OUTPUT_DIRECTORY');
  await downloadEditorialSubset(process.argv[2]);
}
