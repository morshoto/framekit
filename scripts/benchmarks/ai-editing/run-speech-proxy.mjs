// Usage: node run-speech-proxy.mjs SPEECH_ONLY_MP4 MIXED_MP4 PYTHON
// Configure the production speech backend through FRAMEKIT_* environment variables.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAsset } from './corpus.mjs';
import { proxyModel, proxyVariant, recognitionRetention } from './speech-consistency.mjs';

const [baseline, mixed, python, variant, modelVariant] = process.argv.slice(2);
if (!baseline || !mixed || !python) throw new Error('Expected baseline, mixed render and Python');
const config = JSON.parse(await readFile(new URL('./speech-proxy-case.json',import.meta.url),'utf8'));
const selected = proxyVariant(config,variant);
await verifyAsset(baseline,selected.baselineSha256);
await verifyAsset(mixed,selected.mixedSha256);
const model = proxyModel(config,modelVariant === 'primary' ? undefined : modelVariant);
if (process.env.FRAMEKIT_WHISPER_MODEL !== model) throw new Error('Unexpected proxy model');
const repository = fileURLToPath(new URL('../../../',import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = {id:'speech-proxy',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
function analyze(path,digest,id) {
  const media = {mediaId:id,source:resolve(path),sourceDigest:digest,mediaKind:'video',duration:10};
  const child = spawnSync(python,['apps/mcp-server/runtime/whisper-speech-backend.py'],{cwd:repository,env:process.env,
    input:JSON.stringify({media,revision,range:{start:0,end:10}}),encoding:'utf8',maxBuffer:16*1024*1024});
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Speech backend failed: ${child.stderr}`);
  const output = JSON.parse(child.stdout);
  const tokens = output.words.flatMap((word) => word.text.trim().split(/\s+/u)).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return {tokens, digest:hash(child.stdout), provider:output.provider, lowConfidenceWords:output.words.filter((word)=>word.confidence<0.8).length};
}
const original = analyze(baseline,selected.baselineSha256,'baseline');
const result = analyze(mixed,selected.mixedSha256,'mixed');
const comparison = recognitionRetention(original.tokens,result.tokens);
const report = {gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),
  baselineSha256:selected.baselineSha256,mixedSha256:selected.mixedSha256,model,provider:original.provider,
  baselineAnalysisSha256:original.digest,mixedAnalysisSha256:result.digest,
  baselineLowConfidenceWords:original.lowConfidenceWords,mixedLowConfidenceWords:result.lowConfidenceWords,
  comparison,minimumExploratoryRetention:config.minimumExploratoryRetention,
  meetsExploratoryTarget:comparison.retention === null ? null : comparison.retention >= config.minimumExploratoryRetention,
  limitation:config.limitation+' Provider declarations do not authenticate loaded model bytes.'};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
