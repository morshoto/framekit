import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FcpxmlDocumentAdapter, compileTimelineIrToFcpxml } from '@framekit/final-cut/fcpxml';
import { createTimelineIrFromProjectSnapshot, timelineIrDigest } from '@framekit/runtime';

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
