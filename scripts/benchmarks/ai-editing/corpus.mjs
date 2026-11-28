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

export async function parseAmiWords(xml, speaker) {
  const { XMLParser } = await import('fast-xml-parser');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  const root = parsed['nite:root'];
  if (!root || !Array.isArray(root.w) && !root.w) throw new Error('Invalid AMI annotation');
  const words = Array.isArray(root.w) ? root.w : [root.w];
  return words.flatMap((word) => {
    const start = Number(word['@_starttime']);
    const end = Number(word['@_endtime']);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start
      || word['@_starttime'] === undefined || word['@_endtime'] === undefined) throw new Error('Invalid AMI word timing');
    if (start === end) return [];
    return [{ start, end, text: String(word['#text'] ?? ''), speaker, verification: 'automatic-alignment' }];
  });
}
