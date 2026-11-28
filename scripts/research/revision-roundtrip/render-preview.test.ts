import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { createFramekitRenderPlan, createFramekitRenderRequest, type TimelineIr } from '@framekit/runtime';
import { FfmpegTimelineRenderer } from '../../../adapters/headless/typescript/src/index.js';
import { signFixtureClaim } from './signed-handoff.mjs';
import { createSourceBoundRevisionB } from './source-bound.mjs';

const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const time = (value: number) => ({ value: String(value), timescale: '1' });

for (const externalMode of ['authored', 'process'] as const) test(`renders a bounded flattened preview of ${externalMode} signed synthetic B`, { timeout: 60000 }, async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('ffmpeg and ffprobe are required'); return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'framekit-preview-b-'));
  try {
    const sourcePaths = { a: join(dir, 'video.mov'), m: join(dir, 'music.wav') };
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=10', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='between(t,3,3.999)',drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(t,4)'", '-threads', '1', '-c:v', 'mpeg4', sourcePaths.a]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-c:a', 'pcm_s16le', sourcePaths.m]);
    const getXml = async (name: string) => Buffer.from((await readFile(new URL(name, import.meta.url), 'utf8'))
      .replace('file:///synthetic/interview.mov', pathToFileURL(sourcePaths.a).href)
      .replace('file:///synthetic/music.wav', pathToFileURL(sourcePaths.m).href));
    const baseline = await getXml('./anchored-base.fcpxml');
    let external: Buffer;
    if (externalMode === 'process') {
      const inputPath = join(dir, 'a.fcpxml'), editPath = join(dir, 'external.fcpxml');
      await writeFile(inputPath, baseline, { flag: 'wx' });
      await run('python3', ['scripts/research/revision-roundtrip/external-edit.py', inputPath, editPath]);
      external = await readFile(editPath);
      assert.notEqual(hash(baseline), hash(external));
    } else external = await getXml('./anchored-edit.fcpxml');
    const sourceBytes = { a: await readFile(sourcePaths.a), m: await readFile(sourcePaths.m) };
    const pair = generateKeyPairSync('ed25519');
    const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1', baselineDigest: hash(baseline), externalDigest: hash(external),
      sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) }, sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
    const result = await createSourceBoundRevisionB({ baseline, external, sourcePaths, envelope: signFixtureClaim(claim, pair.privateKey),
      trustedKey: pair.publicKey, expectedProject: claim.projectUid, expectedTarget: claim.targetId });
    const originalB = Buffer.from(result.xml), bPath = join(dir, 'b.fcpxml');
    await writeFile(bPath, originalB, { flag: 'wx' });
    if (externalMode === 'process' && process.env.FRAMEKIT_RESEARCH_DTD) {
      for (const path of [join(dir, 'a.fcpxml'), join(dir, 'external.fcpxml'), bPath]) {
        await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, path]);
      }
      t.diagnostic('process A, external XML and B validated against supplied DTD');
    }
    assert.match((await run('python3', ['scripts/research/revision-roundtrip/verify-anchored.py', bPath, 'Synthetic rename'])).stdout, /manifest verified/);
    const project = new XMLParser({ ignoreAttributes: false }).parse(originalB.toString()).fcpxml.library.event.project;
    const clips = project.sequence.spine['asset-clip'];
    assert.equal(clips.length, 3);
    const integerSeconds = (value: string) => { assert.match(value, /^\d+s$/); return Number(value.slice(0, -1)); };
    const video = clips.map((clip: any, i: number) => ({ id: `video-${i}`, name: clip['@_name'],
      startTime: time(integerSeconds(clip['@_offset'])), durationTime: time(integerSeconds(clip['@_duration'])),
      sourceStartTime: time(integerSeconds(clip['@_start'])), track: 0, role: 'video' as const, mediaId: 'a' }));
    const first = clips[0], audio = first.audio, title = first.title;
    assert.equal(audio['@_lane'], '-1'); assert.equal(audio['@_ref'], 'm');
    const position = (child: any) => integerSeconds(first['@_offset']) + integerSeconds(child['@_offset']) - integerSeconds(first['@_start']);
    const timeline: TimelineIr = { schemaVersion: 1, project: { id: 'preview', name: 'Preview' },
      sequence: { id: 'preview-sequence', name: 'Preview', durationTime: time(3), frameDuration: { value: '1', timescale: '30' },
        occurrences: [...video, { id: 'audio', name: 'Tone', startTime: time(position(audio)), durationTime: time(integerSeconds(audio['@_duration'])),
          sourceStartTime: time(integerSeconds(audio['@_start'])), track: 1, role: 'audio', mediaId: 'm' }],
        storyElements: [], markers: [], captions: [], titles: [{ id: 'title', text: title.text['text-style']['#text'], startTime: time(position(title)), durationTime: time(integerSeconds(title['@_duration'])), lane: 2 }] },
      resources: [
        { id: 'a', name: 'video', mediaKind: 'video', source: sourcePaths.a, sourceKind: 'local-file', sourceDigest: hash(sourceBytes.a), metadata: { durationTime: time(10), streams: [{ kind: 'video', width: 320, height: 180, frameRate: { value: '30', timescale: '1' } }] } },
        { id: 'm', name: 'music', mediaKind: 'audio', source: sourcePaths.m, sourceKind: 'local-file', sourceDigest: hash(sourceBytes.m), metadata: { durationTime: time(10), streams: [{ kind: 'audio', sampleRate: 48000, channels: 1 }] } },
      ], revision: { id: 'preview-only', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' } };
    const renderer = new FfmpegTimelineRenderer();
    const render = async (ir: TimelineIr, path: string) => {
      const request = createFramekitRenderRequest({ timeline: ir, target: { projectId: ir.project.id, sequenceId: ir.sequence.id },
        parameters: { outputPath: path, format: 'mp4', width: 320, height: 180, frameRate: { value: '30', timescale: '1' } } });
      await renderer.render(createFramekitRenderPlan(request, renderer.capabilities(request)));
    };
    const preview = join(dir, 'preview.mp4');
    await render(timeline, preview);
    const withoutTitle = structuredClone(timeline);
    withoutTitle.sequence.titles = [];
    const control = join(dir, 'without-title.mp4');
    await render(withoutTitle, control);
    const frame = async (path: string) => (await run('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
    const titled = await frame(preview), untitled = await frame(control);
    assert.equal(titled.length, untitled.length);
    let changed = 0; for (let i = 0; i < titled.length; i += 1) if (Math.abs(titled[i]! - untitled[i]!) > 15) changed += 1;
    assert.ok(changed > 100, `title control changed only ${changed} color components`);
    assert.deepEqual(await readFile(bPath), originalB);
    const pixel = async (at: string) => (await run('ffmpeg', ['-v', 'error', '-ss', at, '-i', preview, '-frames:v', '1', '-vf', 'crop=2:2:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })).stdout;
    const firstPixel = await pixel('0.5'), secondPixel = await pixel('1.5'), thirdPixel = await pixel('2.5');
    assert.ok(firstPixel[2]! > firstPixel[0]! + 50); assert.ok(secondPixel[0]! > secondPixel[2]! + 50); assert.ok(thirdPixel[1]! > thirdPixel[0]! + 30);
    const samples = async (at: string) => (await run('ffmpeg', ['-v', 'error', '-ss', at, '-t', '0.2', '-i', preview, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' })).stdout;
    const rms = (data: Buffer) => { let sum = 0; for (let i = 0; i < data.length; i += 4) sum += data.readFloatLE(i) ** 2; return Math.sqrt(sum / (data.length / 4)); };
    assert.ok(rms(await samples('0.5')) > 0.01); assert.ok(rms(await samples('2.5')) < 0.001);
    t.diagnostic(`${externalMode} external edit: generated source bytes bound; flattened preview cuts, title control and synthetic audio verified; B XML unchanged`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
