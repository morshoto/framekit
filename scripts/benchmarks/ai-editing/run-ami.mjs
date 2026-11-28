// Usage: node --import tsx scripts/benchmarks/ai-editing/run-ami.mjs ASSET_DIR MEETING START_SECONDS PYTHON
// Configure the production speech backend through its FRAMEKIT_* environment variables.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindSpeechAnalysis } from '../../../packages/runtime/src/speech/analysis.ts';
import { rankNarrativeCuts } from '../../../packages/runtime/src/planning/narrative-cuts.ts';
import { loadCorpus, parseAmiWords, screenAlignedCuts, verifyAsset } from './corpus.mjs';

const [assetDirectory, meeting, startArgument, python] = process.argv.slice(2);
const corpus = await loadCorpus();
const asset = corpus.assets.find((item) => item.kind === 'audio' && item.id === meeting);
if (!asset) throw new Error('Unknown corpus audio');
const start = Number(startArgument);
if (!Number.isInteger(start) || start < 0 || start % 60 !== 0) throw new Error('Expected a 60-second chunk boundary');
if (!asset.rangesSeconds.some(([from, to]) => from <= start && start + 60 <= to)) throw new Error('Window outside corpus');
if (!assetDirectory || !python) throw new Error('Expected asset directory, meeting, start and Python executable');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const archive = corpus.assets.find((item) => item.kind === 'annotations');
await verifyAsset(join(assetDirectory, asset.filename), asset.sha256);
await verifyAsset(join(assetDirectory, archive.filename), archive.sha256);
const words = [];
for (const speaker of 'ABCD') {
  const xml = execFileSync('unzip', ['-p', join(assetDirectory, archive.filename), `words/${meeting}.${speaker}.words.xml`]).toString('latin1');
  words.push(...await parseAmiWords(xml, speaker));
}
const temporary = await mkdtemp(join(tmpdir(), 'framekit-ami-corpus-'));
try {
  const sample = join(temporary, 'sample.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', resolve(assetDirectory, asset.filename), '-t', '60', '-ac', '1', '-ar', '16000', '-y', sample]);
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const sampleDigest = sha256(await readFile(sample));
  const media = { mediaId: `ami-${meeting}-${start}`, source: sample, sourceDigest: sampleDigest, mediaKind: 'audio', duration: 60 };
  const revision = { id: `ami-${meeting}-${start}`, sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' };
  const request = { media, revision, range: { start: 0, end: 60 } };
  const backend = spawnSync(python, ['apps/mcp-server/runtime/whisper-speech-backend.py'], {
    cwd: repository, env: process.env, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (backend.error) throw backend.error;
  if (backend.status !== 0) throw new Error(`Speech backend failed: ${backend.stderr}`);
  const providerOutput = JSON.parse(backend.stdout);
  const analysis = bindSpeechAnalysis(providerOutput, { input: { project: { revision }, media }, provider: providerOutput.provider, range: request.range });
  const range = { start: 0, end: 60, startTime: { value: '0', timescale: '1' }, durationTime: { value: '60', timescale: '1' } };
  const plan = rankNarrativeCuts({ source: media, revision, projectId: 'ami-project', timelineId: 'ami-sequence', occurrenceId: 'ami-clip', sourceRange: range, sequenceRange: range, sequenceFrameDuration: { value: '1', timescale: '30' }, analysis });
  const report = {
    corpusVersion: corpus.version, meeting, windowSeconds: [start, start + 60],
    sourceSha256: asset.sha256, annotationsSha256: archive.sha256, decodedSha256: sampleDigest,
    backendOutputSha256: sha256(backend.stdout), provider: providerOutput.provider,
    declaredBackend: process.env.FRAMEKIT_WHISPER_BACKEND ?? null,
    declaredModel: process.env.FRAMEKIT_WHISPER_MODEL ?? null,
    declaredVadSha256: process.env.FRAMEKIT_SILERO_VAD_SHA256 ?? null,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    ffmpegVersion: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
    recognizedWords: analysis.words.length, candidates: screenAlignedCuts(plan.candidates, start, words), warnings: plan.warnings,
    referenceTiming: corpus.referenceTiming,
    limitations: ['Reference overlaps are screening disagreements, not proof of speech clipping.', 'A provider declaration does not prove which model bytes were loaded.', 'No listening or native acceptance is implied.'],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
