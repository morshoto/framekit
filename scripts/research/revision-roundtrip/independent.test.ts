import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FcpxmlDocumentAdapter, compileTimelineIrToFcpxml } from '@framekit/final-cut/fcpxml';
import { createTimelineIrFromProjectSnapshot, reconcileTimelineIr, timelineIrDigest } from '@framekit/runtime';

const fixture = 'scripts/research/revision-roundtrip/independent.fcpxml';
const target = { provider: 'final-cut' as const, libraryUid: 'library', eventUid: 'event', projectUid: 'project', sequenceUid: 'sequence' };

test('independent XML exposes negative audio lane round-trip boundary', async () => {
  const xml = await readFile(fixture, 'utf8');
  const snapshot = FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/independent.fcpxml', xml);
  const ir = createTimelineIrFromProjectSnapshot(snapshot);
  assert.equal(createHash('sha256').update(xml).digest('hex'), 'deef4caa90a823e0d57d5608eecfd8fc65c32358d93e9cdda5f65898bb0840a7');
  assert.deepEqual(ir.sequence.frameDuration, { value: '1', timescale: '30' });
  assert.equal(ir.sequence.occurrences.length, 2);
  assert.equal(ir.sequence.occurrences[0]?.sourceStartTime?.value, '1');
  assert.equal(ir.sequence.occurrences[0]?.mediaId, 'a');
  assert.equal(ir.sequence.occurrences[1]?.mediaId, 'm');
  assert.equal(ir.sequence.occurrences[1]?.track, -1);
  assert.equal(timelineIrDigest(ir), 'd97454a4cc07b85ff5e57c0e4fc24013706da40d0f33179aba5f65884019c778');
  assert.throws(() => compileTimelineIrToFcpxml(ir, { target }), /track must be a non-negative integer/);
});

test('independent insertion changes positional occurrence identifiers', async () => {
  const xml = await readFile(fixture, 'utf8');
  const shifted = xml.replace('<spine>', '<spine><gap name="Manual gap" offset="0s" duration="1s"/>')
    .replace('name="Opening" offset="0s"', 'name="Opening" offset="1s"')
    .replace('duration="3s"><spine>', 'duration="4s"><spine>');
  const parse = (value: string) => createTimelineIrFromProjectSnapshot(
    FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/independent.fcpxml', value),
  );
  const before = parse(xml);
  const after = parse(shifted);
  const beforeClip = before.sequence.occurrences.find(item => item.name === 'Opening');
  const afterClip = after.sequence.occurrences.find(item => item.name === 'Opening');
  assert.ok(beforeClip && afterClip);
  assert.equal(beforeClip.mediaId, afterClip.mediaId);
  assert.deepEqual(beforeClip.sourceStartTime, afterClip.sourceStartTime);
  assert.notEqual(beforeClip.id, afterClip.id);
  assert.notEqual(timelineIrDigest(before), timelineIrDigest(after));
});


test('reconciliation reports a conflict when a structurally shifted clip was also renamed', async () => {
  const original = (await readFile(fixture, 'utf8')).replace(/<audio ref="m"[^>]*\/>/, '');
  const shifted = original.replace('<spine>', '<spine><gap name="Manual gap" offset="0s" duration="1s"/>')
    .replace('name="Opening" offset="0s"', 'name="Opening" offset="1s"')
    .replace('duration="3s"><spine>', 'duration="4s"><spine>');
  const parse = (value: string) => createTimelineIrFromProjectSnapshot(
    FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/independent.fcpxml', value),
  );
  const base = parse(original);
  const ours = structuredClone(base);
  ours.sequence.occurrences[0]!.name = 'Agent rename';
  const theirs = parse(shifted);
  theirs.revision = { id: 'synthetic-external', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' };
  const result = reconcileTimelineIr({ base, ours, theirs });
  assert.equal(result.status, 'conflicted');
  assert.equal(result.merged, undefined);
  assert.ok(result.conflicts.some(conflict => conflict.kind === 'delete-modify-conflict'));
});

test('same-name insertion can redirect a rename through positional identity', async () => {
  const original = (await readFile(fixture, 'utf8')).replace(/<audio ref="m"[^>]*\/>/, '');
  const shifted = original.replace('name="Opening" offset="0s"', 'name="Opening" offset="1s"')
    .replace('<spine>', '<spine><asset-clip ref="a" name="Opening" offset="0s" start="4s" duration="1s"/>')
    .replace('duration="3s"><spine>', 'duration="4s"><spine>');
  const parse = (value: string) => createTimelineIrFromProjectSnapshot(
    FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/independent.fcpxml', value),
  );
  const base = parse(original);
  const ours = structuredClone(base);
  ours.sequence.occurrences[0]!.name = 'Agent rename';
  const theirs = parse(shifted);
  theirs.revision = { id: 'synthetic-external', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' };
  const result = reconcileTimelineIr({ base, ours, theirs });
  assert.equal(result.status, 'rebased');
  const renamed = result.merged?.sequence.occurrences.find(item => item.name === 'Agent rename');
  assert.deepEqual(renamed?.sourceStartTime, { value: '4', timescale: '1' });
  assert.deepEqual(base.sequence.occurrences[0]?.sourceStartTime, { value: '1', timescale: '1' });
  assert.equal(result.conflicts.length, 0);
});


test('document revision advances within one adapter but resets on a fresh adapter', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'framekit-903-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.fcpxml');
  const before = await readFile(fixture, 'utf8');
  const after = before.replace('name="Opening"', 'name="Manually changed"');
  await writeFile(path, before);
  const adapter = new FcpxmlDocumentAdapter(path);
  const first = await adapter.readProject();
  await writeFile(path, after);
  const sameAdapter = await adapter.readProject();
  const freshAdapter = await new FcpxmlDocumentAdapter(path).readProject();
  assert.notEqual(first.revision.id, sameAdapter.revision.id);
  assert.deepEqual(freshAdapter.revision, first.revision);
  assert.notEqual(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'));
  assert.equal(freshAdapter.timeline.clips[0]?.name, 'Manually changed');
});
