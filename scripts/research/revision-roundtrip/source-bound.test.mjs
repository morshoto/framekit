import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signFixtureClaim } from './signed-handoff.mjs';
import { createSourceBoundRevisionB } from './source-bound.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('binds signed synthetic source bytes to both XML references', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-source-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePaths = { a: join(dir, 'video.bin'), m: join(dir, 'music.bin') };
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  await Promise.all(Object.keys(sourcePaths).map(id => writeFile(sourcePaths[id], sourceBytes[id])));
  const fixture = async name => Buffer.from((await readFile(new URL(name, import.meta.url), 'utf8'))
    .replace('file:///synthetic/interview.mov', pathToFileURL(sourcePaths.a).href)
    .replace('file:///synthetic/music.wav', pathToFileURL(sourcePaths.m).href));
  const baseline = await fixture('./anchored-base.fcpxml');
  const external = await fixture('./anchored-edit.fcpxml');
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const options = { baseline, external, sourcePaths, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
    expectedProject: claim.projectUid, expectedTarget: claim.targetId };
  const unsigned = { ...options.envelope, signature: Buffer.alloc(64).toString('base64') };
  const absentPath = join(dir, 'missing.bin');
  const absentUrl = pathToFileURL(absentPath).href;
  const missingA = Buffer.from(baseline.toString().replace(pathToFileURL(sourcePaths.a).href, absentUrl));
  const missingB = Buffer.from(external.toString().replace(pathToFileURL(sourcePaths.a).href, absentUrl));
  await assert.rejects(createSourceBoundRevisionB({ ...options, baseline: missingA, external: missingB,
    sourcePaths: { ...sourcePaths, a: absentPath }, envelope: unsigned }), /signature/);
  await assert.rejects(createSourceBoundRevisionB({ ...options, baseline: missingA, external: missingB,
    sourcePaths: { ...sourcePaths, a: absentPath } }), /stale/);
  const result = await createSourceBoundRevisionB(options);
  assert.match(result.xml.toString(), /Synthetic rename/);
  const output = join(dir, 'b.fcpxml');
  await writeFile(output, result.xml, { flag: 'wx' });
  const verifier = new URL('./verify-anchored.py', import.meta.url).pathname;
  const verified = await promisify(execFile)('python3', [verifier, output, 'Synthetic rename']);
  assert.match(verified.stdout, /manifest verified/);
  const alteredExternal = Buffer.from(external.toString().replace(pathToFileURL(sourcePaths.a).href, pathToFileURL(sourcePaths.m).href));
  const alteredEnvelope = signFixtureClaim({ ...claim, externalDigest: hash(alteredExternal) }, pair.privateKey);
  await assert.rejects(createSourceBoundRevisionB({ ...options, external: alteredExternal, envelope: alteredEnvelope }), /source reference/);
  await writeFile(sourcePaths.a, 'changed bytes');
  await assert.rejects(createSourceBoundRevisionB(options), /stale/);
  await writeFile(sourcePaths.a, sourceBytes.a);
  const other = join(dir, 'other.bin');
  await writeFile(other, sourceBytes.a);
  await assert.rejects(createSourceBoundRevisionB({ ...options, sourcePaths: { ...sourcePaths, a: other } }), /source reference/);
  await rm(sourcePaths.a);
  await symlink(other, sourcePaths.a);
  await assert.rejects(createSourceBoundRevisionB(options), /ELOOP|symbolic|symlink/i);
});

test('binds generated video and audio source files to the signed synthetic handoff', { timeout: 60000 }, async t => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('ffmpeg and ffprobe are required for this optional media experiment');
    return;
  }
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'framekit-source-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePaths = { a: join(dir, 'video.mov'), m: join(dir, 'music.wav') };
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30', '-t', '10', '-threads', '1', '-c:v', 'mpeg4', '-y', sourcePaths.a]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', 'pcm_s16le', '-y', sourcePaths.m]);
  for (const [id, stream] of [['a', 'video'], ['m', 'audio']]) {
    const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,sample_rate:format=duration', '-of', 'json', sourcePaths[id]]);
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].codec_type, stream);
    assert.ok(Number(probe.format.duration) >= 10);
    if (id === 'a') assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [1280, 720]);
    else assert.equal(probe.streams[0].sample_rate, '48000');
  }
  const fixture = async name => Buffer.from((await readFile(new URL(name, import.meta.url), 'utf8'))
    .replace('file:///synthetic/interview.mov', pathToFileURL(sourcePaths.a).href)
    .replace('file:///synthetic/music.wav', pathToFileURL(sourcePaths.m).href));
  const baseline = await fixture('./anchored-base.fcpxml'), external = await fixture('./anchored-edit.fcpxml');
  const sourceBytes = { a: await readFile(sourcePaths.a), m: await readFile(sourcePaths.m) };
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const result = await createSourceBoundRevisionB({ baseline, external, sourcePaths, envelope: signFixtureClaim(claim, pair.privateKey),
    trustedKey: pair.publicKey, expectedProject: claim.projectUid, expectedTarget: claim.targetId });
  const output = join(dir, 'b.fcpxml');
  await writeFile(output, result.xml, { flag: 'wx' });
  const verifier = new URL('./verify-anchored.py', import.meta.url).pathname;
  assert.match((await run('python3', [verifier, output, 'Synthetic rename'])).stdout, /manifest verified/);
  t.diagnostic('generated video/audio, signed source binding and independent XML verification succeeded');
});
