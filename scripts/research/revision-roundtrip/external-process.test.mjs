import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSignedRevisionB, signFixtureClaim } from './signed-handoff.mjs';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const file = name => new URL(name, import.meta.url).pathname;

test('separate Python editor produces an external revision that reconciles to independently checked B', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-external-editor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const editedPath = join(dir, 'edited.fcpxml');
  const outputPath = join(dir, 'b.fcpxml');
  const baseline = await readFile(file('./anchored-base.fcpxml'));
  await run('python3', [file('./external-edit.py'), file('./anchored-base.fcpxml'), editedPath]);
  const external = await readFile(editedPath);
  assert.notEqual(hash(baseline), hash(external));
  const sourceBytes = { a: Buffer.from('synthetic video'), m: Buffer.from('synthetic music') };
  const pair = generateKeyPairSync('ed25519');
  const claim = { version: 1, projectUid: 'project-framekit-8b68711b3f', targetId: 'opening-v1',
    baselineDigest: hash(baseline), externalDigest: hash(external), sourceDigests: { a: hash(sourceBytes.a), m: hash(sourceBytes.m) },
    sourceStart: '2s', duration: '1s', name: 'Synthetic rename' };
  const result = createSignedRevisionB({ baseline, external, sourceBytes, envelope: signFixtureClaim(claim, pair.privateKey),
    trustedKey: pair.publicKey, expectedProject: claim.projectUid, expectedTarget: claim.targetId });
  await writeFile(outputPath, result.xml, { flag: 'wx' });
  assert.equal(hash(result.xml), result.digest);
  assert.match((await run('python3', [file('./verify-anchored.py'), outputPath, 'Synthetic rename'])).stdout, /manifest verified/);
  if (process.env.FRAMEKIT_RESEARCH_DTD) {
    for (const path of [editedPath, outputPath]) await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_RESEARCH_DTD, path]);
    t.diagnostic('external revision and B validated against the supplied DTD');
  }
  t.diagnostic(`A ${hash(baseline)} external ${hash(external)} B ${result.digest}`);
});
