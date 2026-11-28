import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRevision, writeRevision } from './revision-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'framekit-revision-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('persists a digest-bound revision for a fresh process', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'revision.json');
  const artifact = join(directory, 'artifact.fcpxml');
  const bytes = Buffer.from('<fcpxml/>');
  await writeFile(artifact, bytes);
  const record = await writeRevision(path, bytes, 'project-a');
  assert.match(record.digest, /^[a-f0-9]{64}$/);
  const child = await promisify(execFile)(process.execPath, [new URL('./read-revision.mjs', import.meta.url).pathname, path, artifact, 'project-a']);
  assert.deepEqual(JSON.parse(child.stdout), record);
  await assert.rejects(writeRevision(path, bytes, 'project-a'), /EEXIST/);
});

test('rejects changed artifacts, wrong target, partial record and symlink', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'revision.json');
  const bytes = Buffer.from('<fcpxml/>');
  await assert.rejects(readRevision(join(directory, 'missing.json'), bytes, 'project-a'), /ENOENT/);
  await writeRevision(path, bytes, 'project-a');
  await assert.rejects(readRevision(path, Buffer.from('<fcpxml />'), 'project-a'), /stale/);
  await assert.rejects(readRevision(path, bytes, 'project-b'), /target/);
  await writeFile(path, '{');
  await assert.rejects(readRevision(path, bytes, 'project-a'), /invalid/);
  const link = join(directory, 'link.json');
  await symlink(path, link);
  await assert.rejects(readRevision(link, bytes, 'project-a'));
});

test('valid replacement of record and artifact is not authenticated', async t => {
  const directory = await fixture(t);
  const original = join(directory, 'original.json');
  const replacement = join(directory, 'replacement.json');
  const oldBytes = Buffer.from('<fcpxml/>');
  const newBytes = Buffer.from('<fcpxml version="1.11"/>');
  await writeRevision(original, oldBytes, 'project-a');
  await writeRevision(replacement, newBytes, 'project-a');
  await writeFile(original, await readFile(replacement));
  assert.equal((await readRevision(original, newBytes, 'project-a')).digest, (await readRevision(replacement, newBytes, 'project-a')).digest);
});
