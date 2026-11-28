// Usage: node run-cut-proxy.mjs SOURCE_WAV PYTHON NEW_OUTPUT_DIRECTORY
// Set FRAMEKIT_WHISPER_MODEL to one of the fixed case models and configure the production backend.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { compareRecognitionProviders, compareRecognizedWords, pcmWav, prepareCutPcm } from './cut-proxy.mjs';

const [sourcePath,python,outputArg] = process.argv.slice(2);
if (!sourcePath || !python || !outputArg) throw new Error('Expected source, Python and new output directory');
const config = JSON.parse(await readFile(new URL('./cut-proxy-case.json',import.meta.url),'utf8'));
const source = (await loadCorpus()).assets.find((asset)=>asset.id===config.meeting);
await verifyAsset(sourcePath,source.sha256);
const model = process.env.FRAMEKIT_WHISPER_MODEL;
if (!config.models.includes(model)) throw new Error('Unexpected proxy model');
const [windowStart,windowEnd] = config.windowSamples;
const [cutStart,cutEnd] = config.removedSamples;
const pcm = execFileSync('ffmpeg',['-v','error','-i',sourcePath,'-af',`atrim=start_sample=${windowStart}:end_sample=${windowEnd}`,
  '-ac','1','-ar',String(config.sampleRate),'-f','s16le','pipe:1'],{maxBuffer:4*1024*1024});
if (pcm.length !== (windowEnd-windowStart)*2) throw new Error('Source window is incomplete');
const pair = prepareCutPcm(pcm,cutStart-windowStart,cutEnd-windowStart);
const output = resolve(outputArg);
await mkdir(output);
const originalPath=join(output,'original.wav'), cutPath=join(output,'cut.wav');
const originalWav=pcmWav(pair.original,config.sampleRate), cutWav=pcmWav(pair.cut,config.sampleRate);
await writeFile(originalPath,originalWav); await writeFile(cutPath,cutWav);
const hash = (bytes)=>createHash('sha256').update(bytes).digest('hex');
const repository = fileURLToPath(new URL('../../../',import.meta.url));
const revision = {id:'cut-proxy',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
function recognize(path,bytes,id) {
  const duration = (bytes.length-44)/2/config.sampleRate;
  const media = {mediaId:id,source:path,sourceDigest:hash(bytes),mediaKind:'audio',duration};
  const child = spawnSync(python,['apps/mcp-server/runtime/whisper-speech-backend.py'],{cwd:repository,env:process.env,
    input:JSON.stringify({media,revision,range:{start:0,end:duration}}),encoding:'utf8',maxBuffer:16*1024*1024});
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Speech backend failed: ${child.stderr}`);
  const response=JSON.parse(child.stdout);
  const tokens=response.words.flatMap((word)=>word.text.trim().split(/\s+/u)).filter((word)=>/[\p{L}\p{N}]/u.test(word));
  return {tokens,analysisSha256:hash(child.stdout),provider:response.provider,lowConfidenceWords:response.words.filter((word)=>word.confidence<0.8).length};
}
const original = recognize(originalPath,originalWav,'original');
const cut = recognize(cutPath,cutWav,'cut');
const comparison = compareRecognizedWords(original.tokens,cut.tokens);
const report = {gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),
  sourceSha256:source.sha256,windowSamples:config.windowSamples,removedSamples:config.removedSamples,sampleRate:config.sampleRate,
  originalWavSha256:hash(originalWav),cutWavSha256:hash(cutWav),model,providers:compareRecognitionProviders(original.provider,cut.provider),declaredAnalyzerVersion:process.env.FRAMEKIT_SPEECH_ANALYZER_VERSION ?? null,
  ffmpegVersion:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],
  originalAnalysisSha256:original.analysisSha256,cutAnalysisSha256:cut.analysisSha256,
  originalLowConfidenceWords:original.lowConfidenceWords,cutLowConfidenceWords:cut.lowConfidenceWords,comparison,
  minimumExploratoryRetention:config.minimumExploratoryRetention,
  meetsExploratoryTarget:comparison.retention === null ? null : comparison.retention >= config.minimumExploratoryRetention,
  limitation:config.limitation+' Model declarations do not authenticate loaded model bytes.'};
await writeFile(join(output,'report.json'),`${JSON.stringify(report,null,2)}\n`);
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
