// Usage: node --import tsx scripts/benchmarks/ai-editing/run-music.mjs AMI_WAV MUSIC_OGG NEW_OUTPUT_DIRECTORY [GAIN_DB]
// Produces disposable headless renders for measurement and separate human listening.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFramekitRenderPlan, createFramekitRenderRequest } from '../../../packages/runtime/src/index.ts';
import { FfmpegTimelineRenderer } from '../../../adapters/headless/typescript/src/index.ts';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { estimateOffsetFrames, measureMix, selectedGain } from './music-quality.mjs';

const [speechFile, musicFile, outputArg, gainArgument] = process.argv.slice(2);
if (!speechFile || !musicFile || !outputArg) throw new Error('Expected speech, music and new output directory');
const corpus = await loadCorpus();
const config = JSON.parse(await readFile(new URL('./music-corpus.json', import.meta.url), 'utf8'));
const speech = corpus.assets.find((asset) => asset.id === config.speech.corpusAsset);
const gainDb = selectedGain(gainArgument, config.scenario.gainDb);
await verifyAsset(speechFile, speech.sha256);
await verifyAsset(musicFile, config.music.sha256);
const output = resolve(outputArg);
await mkdir(output);
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const call = (args, options = {}) => execFileSync(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024, ...options });
const withSpeech = join(output, 'source-speech.mp4');
const silent = join(output, 'source-silent.mp4');
call(['-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=10','-ss','60','-i',resolve(speechFile),'-t','10','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',withSpeech]);
call(['-v','error','-i',withSpeech,'-map','0:v:0','-c:v','copy','-an',silent]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const speechDigest = sha(await readFile(withSpeech));
const silentDigest = sha(await readFile(silent));
const time = (n) => ({ value: String(n), timescale: '1' });
const renderer = new FfmpegTimelineRenderer({ffmpegPath: ffmpeg});
async function render(name, hasSpeech, hasMusic) {
  const source = hasSpeech ? withSpeech : silent;
  const video = {id:'video', name:'Video', mediaKind:'video', source, sourceKind:'local-file', sourceDigest: hasSpeech ? speechDigest : silentDigest,
    metadata:{durationTime:time(10), streams:[{kind:'video',width:320,height:180,frameRate:time(30)}, ...(hasSpeech ? [{kind:'audio',sampleRate:48000,channels:2}] : [])]}};
  const music = {id:'music', name:'Music', mediaKind:'audio', source:resolve(musicFile), sourceKind:'local-file', sourceDigest:config.music.sha256,
    metadata:{durationTime:time(169), streams:[{kind:'audio',sampleRate:44100,channels:2}]}};
  const timeline = {schemaVersion:1, project:{id:'music-quality',name:'Music quality'}, revision:{id:'r1',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'},
    resources:hasMusic ? [video,music] : [video], sequence:{id:'sequence',name:'Sequence',durationTime:time(10),frameDuration:{value:'1',timescale:'30'},
      occurrences:[{id:'video',name:'Video',startTime:time(0),durationTime:time(10),sourceStartTime:time(0),track:0,role:'video',mediaId:'video'},
        ...(hasMusic ? [{id:'music',name:'Music',startTime:time(2),durationTime:time(6),sourceStartTime:time(0),track:1,role:'music',mediaId:'music',gainDb}] : [])],
      storyElements:[],markers:[],captions:[],titles:[],transitions:[]}};
  const path = join(output, `${name}.mp4`);
  const request = createFramekitRenderRequest({timeline,target:{projectId:timeline.project.id,sequenceId:timeline.sequence.id},parameters:{outputPath:path,format:'mp4',width:320,height:180,frameRate:time(30)}});
  await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
  return path;
}
const speechRender = await render('speech-only', true, false);
const musicRender = await render('music-only', false, true);
const mixedRender = await render('mixed', true, true);
const decode = (path, start, length) => {
  const args = ['-v','error', ...(start === undefined ? [] : ['-ss',String(start)]), '-i',path, ...(length === undefined ? [] : ['-t',String(length)]), '-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'];
  const bytes = call(args);
  const samples = new Float32Array(bytes.length / 4);
  for (let i=0; i<samples.length; i++) samples[i] = bytes.readFloatLE(i*4);
  return samples;
};
const a = decode(speechRender), b = decode(musicRender), c = decode(mixedRender);
if (a.length !== b.length || a.length !== c.length) throw new Error('Decoded component lengths differ');
const window = (values, from, to) => values.subarray(Math.round(from*48000),Math.round(to*48000));
const measurements = config.scenario.measurementWindowsSeconds.map(([from,to]) => ({rangeSeconds:[from,to],...measureMix(window(a,from,to),window(b,from,to),window(c,from,to))}));
const rms = (samples) => Math.sqrt(samples.reduce((sum, sample) => sum + sample*sample, 0) / samples.length);
const musicReference = decode(resolve(musicFile), 1, 4);
const inputMusicRms = rms(musicReference);
const placement = estimateOffsetFrames(musicReference, b, 3 * 48000, 1600, 5);
const renderedMusicRms = rms(window(b,3,7));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const report = {gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(), speechSha256:speech.sha256, musicSha256:config.music.sha256,
  preparedSpeechSha256:speechDigest, outputs:{speech:sha(await readFile(speechRender)),music:sha(await readFile(musicRender)),mixed:sha(await readFile(mixedRender))},
  ffmpegVersion:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0], sampleRate:48000, measurements,
  placement, requestedGainDb:gainDb, observedMusicGainDb:20*Math.log10(renderedMusicRms/inputMusicRms),
  limitation:'The speech field measures all source audio in each window, including silence; it is not a speech-only signal-to-noise ratio. Alignment is measured at frame resolution on isolated music. The direct headless render does not test planning or approval. Levels and lossy-encoding residuals do not establish dialogue intelligibility, creative suitability or native acceptance.'};
await writeFile(join(output,'report.json'), `${JSON.stringify(report,null,2)}\n`);
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
