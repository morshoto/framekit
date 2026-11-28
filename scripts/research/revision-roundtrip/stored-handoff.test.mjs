import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoredRevisionB } from './stored-handoff.mjs';
import { readRevision, writeRevision } from './revision-store.mjs';

test('uses saved A and external pins to create an independently checked B record', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-stored-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = await readFile(new URL('./independent-edited.fcpxml', import.meta.url));
  const external = await readFile(new URL('./external-cut.fcpxml', import.meta.url));
  const target = 'project-framekit-8b68711b3f';
  const baselineRecord = join(dir, 'a.json');
  const externalRecord = join(dir, 'external.json');
  const output = join(dir, 'b.fcpxml');
  const outputRecord = join(dir, 'b.json');
  await writeRevision(baselineRecord, baseline, target);
  await writeRevision(externalRecord, external, target);
  const options = { baseline, external, baselineRecord, externalRecord, output, outputRecord, projectUid: target,
    sourceDigests: { a: 'a'.repeat(64), m: 'b'.repeat(64) }, targetIndex: 0, name: 'Approved name' };
  const result = await createStoredRevisionB(options);
  assert.equal((await readRevision(outputRecord, await readFile(output), target)).digest, result.digest);
  await assert.rejects(createStoredRevisionB(options), /EEXIST/);
  await assert.rejects(createStoredRevisionB({ ...options, external: Buffer.from('changed'), output: join(dir, 'other'), outputRecord: join(dir, 'other.json') }), /stale/);
});
