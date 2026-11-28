// Offline, fixture-only use of a pinned third-party editor core; no media or apps are opened.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAnchoredTarget } from './anchor-identity.mjs';

const [checkout, outputPath] = process.argv.slice(2);
assert.ok(checkout && outputPath, 'usage: tsx uncut-probe.ts <pinned checkout> <new output>');
assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), '9fb9733b4465f459f545c9beb9268580bcd78282');
const load = (path: string) => import(pathToFileURL(resolve(checkout, 'packages/core/src/timeline', path)).href);
const { readFcpxml, planImportTimeline } = await load('interchange/readFcpxml.ts');
const { writeFcpxml } = await load('interchange/fcpxml.ts');
const { createSession, applyEdit } = await load('apply-ops.ts');
const input = readFileSync(new URL('./anchored-base.fcpxml', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(input).digest('hex'), '8492d63353faeaa9a3e4afb9d6f0a789fc3c79ef079f57ed2314bd9dfd8d7bfe');
const file = readFcpxml(input);
assert.ok(!('problem' in file));
const media = [
  { id: 'video', kind: 'video', name: 'Interview', path: '/synthetic/interview.mov', probe: { frames: 300, width: 1280, height: 720, hasAudio: false } },
  { id: 'music', kind: 'audio', name: 'Music', path: '/synthetic/music.wav', probe: { frames: 300, hasAudio: true } },
];
const project = { format: 'uncut/0', name: 'Synthetic', canvas: { width: 1280, height: 720, fps: 30 }, media, tracks: [{ id: 'main', kind: 'video', role: 'main', items: [] }] };
const plan = planImportTimeline(project, file, (p: string) => media.find(m => m.path === p), new Set());
assert.ok(!('problem' in plan));
assert.equal(plan.clips, 4);
const imported = applyEdit(createSession(project), { actor: 'user', ops: plan.ops }).project;
const opening = imported.tracks.find((t: {role?: string}) => t.role === 'main')?.items.find((i: {name?: string}) => i.name === 'Opening');
assert.ok(opening);
const edited = applyEdit(createSession(imported), { actor: 'user', ops: [{ op: 'split_item', item: opening.id, at: 15, newId: 'synthetic-split' }] }).project;
const result = writeFcpxml(edited, (m: {path: string}) => m.path);
const reread = readFcpxml(result.text);
assert.ok(!('problem' in reread));
assert.equal(reread.clips.filter((c: {lane: number}) => c.lane === 0).length, 3);
assert.ok(reread.clips.some((c: {kind: string, text?: string}) => c.kind === 'text' && c.text === 'Intro'));
assert.ok(reread.clips.some((c: {lane: number, path?: string}) => c.lane < 0 && c.path === '/synthetic/music.wav'));
assert.doesNotMatch(result.text, /com\.framekit\.id|project-framekit-8b68711b3f/);
assert.throws(() => findAnchoredTarget(input, result.text, 'opening-v1', { sourceStart: '1s', duration: '1/2s' }), /invalid XML/);
assert.throws(() => findAnchoredTarget(input, result.text.replace('<!DOCTYPE fcpxml>', ''), 'opening-v1', { sourceStart: '1s', duration: '1/2s' }), /unsupported FCPXML version/);
writeFileSync(outputPath, result.text, { flag: 'wx' });
console.log(JSON.stringify({ importWarnings: plan.warnings, exportWarnings: result.warnings, imported: plan.clips, splitAtFrames: 15, outputVersion: '1.10', outputSha256: createHash('sha256').update(result.text).digest('hex'), clips: reread.clips }, null, 2));
