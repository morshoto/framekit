// Usage: FRAMEKIT_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo node run-disagreement.mjs SOURCE_WAV PYTHON
// Configure remaining production speech-backend FRAMEKIT_* options before running.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { compareProviderCuts } from './evidence-quality.mjs';

const [sourcePath, python] = process.argv.slice(2);
if (!sourcePath || !python) throw new Error('Expected corpus source and Python executable');
const corpus = await loadCorpus();
const config = JSON.parse(await readFile(new URL('./disagreement-case.json', import.meta.url), 'utf8'));
const source = corpus.assets.find((asset) => asset.id === config.meeting);
await verifyAsset(sourcePath, source.sha256);
if (process.env.FRAMEKIT_WHISPER_MODEL !== config.secondaryModel) throw new Error('Secondary model does not match fixed case');
const [from, to] = config.secondaryWindowSeconds;
const directory = await mkdtemp(join(tmpdir(), 'framekit-provider-screen-'));
try {
  const sample = join(directory, 'sample.wav');
  execFileSync('ffmpeg', ['-v','error','-ss',String(from),'-i',sourcePath,'-t',String(to-from),'-ac','1','-ar','16000',sample]);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const decodedSha256 = hash(await readFile(sample));
  const media = {mediaId:'provider-screen',source:sample,sourceDigest:decodedSha256,mediaKind:'audio',duration:to-from};
  const revision = {id:'provider-screen',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const backend = spawnSync(python, ['apps/mcp-server/runtime/whisper-speech-backend.py'], {
    cwd:repository, env:process.env, input:JSON.stringify({media,revision,range:{start:0,end:to-from}}), encoding:'utf8', maxBuffer:32*1024*1024,
  });
  if (backend.error) throw backend.error;
  if (backend.status !== 0) throw new Error(`Speech backend failed: ${backend.stderr}`);
  const response = JSON.parse(backend.stdout);
  const observed = response.observedRange;
  const evidence = {sourceSha256:source.sha256,coverage:observed && {start:observed.start+from,end:observed.end+from},
    words:response.words.map((word) => ({...word,start:word.start+from,end:word.end+from}))};
  const report = {gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),
    sourceSha256:source.sha256,decodedSha256,backendOutputSha256:hash(backend.stdout),secondaryProvider:response.provider,
    declaredSecondaryModel:config.secondaryModel,primaryModel:config.primaryModel,primaryWindowSeconds:config.primaryWindowSeconds,
    secondaryWindowSeconds:config.secondaryWindowSeconds,candidate:config.candidate,screening:compareProviderCuts([config.candidate],source.sha256,evidence),
    limitation:config.interpretation+' Provider model declarations do not authenticate the loaded model bytes. No native execution occurred.'};
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { await rm(directory,{recursive:true,force:true}); }
