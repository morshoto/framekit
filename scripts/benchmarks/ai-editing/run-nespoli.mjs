// Usage: node scripts/benchmarks/ai-editing/run-nespoli.mjs AUDIO SUBTITLES PYTHON
// Configure the production speech backend through FRAMEKIT_* environment variables.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { compareTranscript, safeWholeSecondDuration, subtitleWords } from './caption-quality.mjs';

const [audio, subtitles, python] = process.argv.slice(2);
if (!audio || !subtitles || !python) throw new Error('Expected audio, subtitles and Python executable');
const corpus = await loadCorpus();
const source = corpus.supplementalAssets.find((item) => item.id === 'nespoli-voice');
const reference = corpus.supplementalAssets.find((item) => item.id === 'nespoli-subtitles');
await verifyAsset(audio, source.sha256);
await verifyAsset(subtitles, reference.sha256);
const expected = subtitleWords(await readFile(subtitles, 'utf8'));
const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audio], {encoding: 'utf8'}));
const analyzedDuration = safeWholeSecondDuration(duration);
const media = { mediaId: source.id, source: resolve(audio), sourceDigest: source.sha256, mediaKind: 'audio', duration };
const revision = { id: 'nespoli-eval', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' };
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const backend = spawnSync(python, ['apps/mcp-server/runtime/whisper-speech-backend.py'], {
  cwd: repository, env: process.env, input: JSON.stringify({ media, revision, range: { start: 0, end: analyzedDuration } }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
if (backend.error) throw backend.error;
if (backend.status !== 0) throw new Error(`Speech backend failed: ${backend.stderr}`);
const output = JSON.parse(backend.stdout);
const recognized = output.words.flatMap((word) => word.text.trim().split(/\s+/u)).filter((word) => /[\p{L}\p{N}]/u.test(word));
const report = {
  sourceSha256: source.sha256, subtitlesSha256: reference.sha256, duration, analyzedDuration,
  backendOutputSha256: createHash('sha256').update(backend.stdout).digest('hex'), provider: output.provider,
  declaredBackend: process.env.FRAMEKIT_WHISPER_BACKEND ?? null, declaredModel: process.env.FRAMEKIT_WHISPER_MODEL ?? null,
  declaredVadSha256: process.env.FRAMEKIT_SILERO_VAD_SHA256 ?? null,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim(),
  transcriptScreening: compareTranscript(expected, recognized),
  lowConfidenceWords: output.words.filter((word) => word.confidence < 0.8).length,
  timingStatus: 'unavailable',
  limitations: ['Published subtitles have not been independently checked against the audio.', 'Subtitle cues are not word-level timing references.', 'A declared model does not prove loaded bytes.', 'No listening, caption rendering or native acceptance is implied.'],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
