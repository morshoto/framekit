import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { signFixtureClaim } from './signed-handoff.mjs';
import { readRevision } from './revision-store.mjs';
import { commitSourceBoundRenumberedRevisionB } from './source-bound-once.mjs';
import { createSourceBoundRenumberedRevisionB } from './source-bound-renumber.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-bound-once-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePaths = { a: join(dir, 'a.bin'), m: join(dir, 'm.bin') };
  const bytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  await Promise.all(['a', 'm'].map(id => writeFile(sourcePaths[id], bytes[id])));
  const load = async name => (await readFile(new URL(name, import.meta.url), 'utf8'))
    .replace('file:///synthetic/interview.mov', pathToFileURL(sourcePaths.a).href)
    .replace('file:///synthetic/music.wav', pathToFileURL(sourcePaths.m).href);
  const baseline = Buffer.from(await load('./anchored-base.fcpxml'));
  const external = Buffer.from((await load('./anchored-edit.fcpxml')).replace('id="a"', 'id="v9"').replaceAll('ref="a"', 'ref="v9"')
    .replace('id="m"', 'id="s8"').replaceAll('ref="m"', 'ref="s8"'));
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1', baselineDigest: hash(baseline), externalDigest: hash(external),
    sourceDigests: { a: hash(bytes.a), m: hash(bytes.m) }, sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  return { baseline, external, sourcePaths, envelope: signFixtureClaim(claim, pair.privateKey), trustedKey: pair.publicKey,
    expectedProject: claim.projectUid, expectedTarget: claim.targetId, claimDirectory: dir, output: join(dir, 'b.fcpxml') };
}

test('source-bound renumbered handoff claims once and records exact B bytes', async t => {
  const input = await fixture(t);
  const attempts = await Promise.allSettled([commitSourceBoundRenumberedRevisionB(input), commitSourceBoundRenumberedRevisionB(input)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
  const result = attempts.find(item => item.status === 'fulfilled').value;
  const output = await readFile(input.output);
  assert.equal(hash(output), result.digest);
  assert.equal((await readRevision(result.claimPath, output, input.expectedProject)).digest, result.digest);
  const run = promisify(execFile);
  assert.match((await run('python3', [new URL('./verify-anchored.py', import.meta.url).pathname, input.output, 'Synthetic rename'])).stdout, /manifest verified/);
  if (process.env.FRAMEKIT_RESEARCH_DTD) await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, input.output]);
  await assert.rejects(commitSourceBoundRenumberedRevisionB({ ...input, output: join(input.claimDirectory, 'replay.fcpxml') }), /EEXIST/);
});

test('source mismatch does not claim a revision or overwrite output', async t => {
  const input = await fixture(t);
  await writeFile(input.sourcePaths.m, 'changed');
  await writeFile(input.output, 'sentinel');
  await assert.rejects(commitSourceBoundRenumberedRevisionB(input), /stale/);
  assert.equal(await readFile(input.output, 'utf8'), 'sentinel');
  assert.equal((await readdir(input.claimDirectory)).filter(name => name.startsWith('claim-')).length, 0);
});

test('output collision retains uncertainty and never overwrites the existing file', async t => {
  const input = await fixture(t);
  await writeFile(input.output, 'sentinel');
  await assert.rejects(commitSourceBoundRenumberedRevisionB(input), /EEXIST/);
  assert.equal(await readFile(input.output, 'utf8'), 'sentinel');
  assert.equal((await readdir(input.claimDirectory)).filter(name => name.startsWith('claim-')).length, 1);
  await assert.rejects(commitSourceBoundRenumberedRevisionB({ ...input, output: join(input.claimDirectory, 'retry.fcpxml') }), /EEXIST/);
});

test('independent processes share the source-bound renumbered claim', async t => {
  const input = await fixture(t);
  const dir = input.claimDirectory;
  await Promise.all([
    writeFile(join(dir, 'baseline.fcpxml'), input.baseline),
    writeFile(join(dir, 'external.fcpxml'), input.external),
    writeFile(join(dir, 'envelope.json'), JSON.stringify(input.envelope)),
    writeFile(join(dir, 'public.pem'), input.trustedKey.export({ type: 'spki', format: 'pem' })),
  ]);
  const pin = hash(input.trustedKey.export({ type: 'spki', format: 'der' }));
  const child = new URL('./source-bound-once-child.mjs', import.meta.url).pathname;
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [child, dir, '0'.repeat(64)]), error => /key pin/.test(error.stderr));
  assert.equal((await readdir(dir)).filter(name => name.startsWith('claim-')).length, 0);
  const results = await Promise.allSettled([run(process.execPath, [child, dir, pin]), run(process.execPath, [child, dir, pin])]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.match(results.find(item => item.status === 'rejected').reason.stderr, /EEXIST/);
  const winner = JSON.parse(results.find(item => item.status === 'fulfilled').value.stdout);
  const output = await readFile(input.output);
  assert.equal(hash(output), winner.digest);
  const claims = (await readdir(dir)).filter(name => name.startsWith('claim-'));
  assert.equal(claims.length, 1);
  assert.equal((await readRevision(join(dir, claims[0]), output, input.expectedProject)).digest, winner.digest);
  assert.match((await run('python3', [new URL('./verify-anchored.py', import.meta.url).pathname, input.output, 'Synthetic rename'])).stdout, /manifest verified/);
  if (process.env.FRAMEKIT_RESEARCH_DTD) await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, input.output]);
  await assert.rejects(run(process.execPath, [child, dir, pin]), error => /EEXIST/.test(error.stderr));
});

test('interruption after source-bound claim leaves no B and blocks a blind retry', async t => {
  const input = await fixture(t);
  const expected = await createSourceBoundRenumberedRevisionB(input);
  const dir = input.claimDirectory;
  await Promise.all([
    writeFile(join(dir, 'baseline.fcpxml'), input.baseline),
    writeFile(join(dir, 'external.fcpxml'), input.external),
    writeFile(join(dir, 'envelope.json'), JSON.stringify(input.envelope)),
    writeFile(join(dir, 'public.pem'), input.trustedKey.export({ type: 'spki', format: 'pem' })),
  ]);
  const pin = hash(input.trustedKey.export({ type: 'spki', format: 'der' }));
  const childScript = new URL('./source-bound-once-child.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [childScript, dir, pin, 'pause-after-claim'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let timer;
  const reached = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString().trim()),
    exited.then(() => 'exited'),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 5000); }),
  ]);
  clearTimeout(timer);
  assert.equal(reached, 'claimed');
  child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const claims = (await readdir(dir)).filter(name => name.startsWith('claim-'));
  assert.equal(claims.length, 1);
  const record = JSON.parse(await readFile(join(dir, claims[0]), 'utf8'));
  assert.equal(record.digest, expected.digest);
  await assert.rejects(readFile(input.output), { code: 'ENOENT' });
  await assert.rejects(promisify(execFile)(process.execPath, [childScript, dir, pin]), error => /EEXIST/.test(error.stderr));
});
