import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

export async function loadCorpus() {
  return JSON.parse(await readFile(new URL('./corpus.json', import.meta.url), 'utf8'));
}

export async function verifyAsset(path, expectedDigest) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expectedDigest) throw new Error(`Asset digest mismatch: ${path}`);
  return actual;
}
