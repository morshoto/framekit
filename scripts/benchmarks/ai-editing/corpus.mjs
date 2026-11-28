import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** Keep PATH command names intact; resolve explicit relative or absolute paths. */
export function resolveProbeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid probe command');
  return command.includes(sep) ? resolve(command) : command;
}

/** Isolate disposable headless runs from inherited native-provider selection. */
export function headlessProbeEnvironment(environment, output) {
  return {...environment,FRAMEKIT_EDITOR:'final-cut-live',FRAMEKIT_AUTO_CONNECT:'0',FRAMEKIT_FINAL_CUT_HEADLESS:'1',FRAMEKIT_FINAL_CUT_NATIVE_WRITES:'0',FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER:'',FRAMEKIT_FINAL_CUT_SOCKET:join(output,'missing.sock'),FRAMEKIT_STATE_DIR:join(output,'state')};
}

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

/** Report review-only previews without treating them as speech-safety proof. */
export function summarizeProductionCutPreviews(cuts, previews, sourceOffset) {
  if (!Array.isArray(cuts) || !Array.isArray(previews) || !Number.isFinite(sourceOffset) || sourceOffset < 0 || cuts.length !== previews.length) throw new Error('Invalid cut preview');
  const candidates=cuts.map((cut,i)=>{
    const range=cut.candidate?.sourceRange;
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || cut.candidate.reviewRequired !== true) throw new Error('Invalid review candidate');
    if (previews[i]?.index !== cut.index || previews[i]?.scope !== 'headless-preview') throw new Error('Invalid headless preview');
    return {sourceRange:{start:range.start+sourceOffset,end:range.end+sourceOffset},confidence:cut.candidate.confidence,evidence:cut.candidate.evidence,reviewRequired:true};
  });
  return {status:candidates.length ? 'screened' : 'unavailable',candidates,speechSafety:'unverified'};
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

/** Report automatic-alignment disagreements, never interpret them as confirmed clipping. */
export function screenAlignedCuts(candidates, offset, words) {
  if (!Number.isFinite(offset) || offset < 0) throw new Error('Invalid source offset');
  return candidates.map((candidate) => {
    if (!candidate?.sourceRange) throw new Error('Invalid candidate range');
    const { start, end } = candidate.sourceRange;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid candidate range');
    const sourceStart = start + offset;
    const sourceEnd = end + offset;
    return { start: sourceStart, end: sourceEnd, overlaps: words.filter((word) => word.start < sourceEnd && sourceStart < word.end) };
  });
}
