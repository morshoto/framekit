import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FcpxmlDocumentAdapter, compileTimelineIrToFcpxml } from '@framekit/final-cut/fcpxml';
import { acceptCreativeBrief, assertBriefBinding, createTimelineIrFromProjectSnapshot, reconcileTimelineIr, type CreativeBrief, type TimelineIr } from '@framekit/runtime';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const target = { provider: 'final-cut' as const, libraryUid: 'library', eventUid: 'event', projectUid: 'project', sequenceUid: 'sequence' };
const time = (value: string) => ({ value, timescale: '1' });

const brief: CreativeBrief = {
  schemaVersion: 1, id: 'research', version: 1,
  purpose: { kind: 'specified', value: 'synthetic' }, audience: { kind: 'no-preference' },
  durationSeconds: { min: 3, max: 3 }, aspectRatio: '16:9', theme: 'plain', visualDirection: 'plain',
  requiredContent: ['opening'], excludedContent: [], speechPolicy: { kind: 'no-preference' },
  musicPolicy: { kind: 'specified', value: 'music' }, captionPolicy: { kind: 'no-preference' },
  sourceCoverage: [{ requirement: 'opening', sourceId: 'a', sourceDigest: 'a'.repeat(64), start: 1, end: 4 }],
  inferences: [], reviewPrompts: [],
};
const timeline: TimelineIr = {
  schemaVersion: 1, project: { id: 'project', name: 'Research' },
  sequence: {
    id: 'sequence', name: 'Main', durationTime: time('3'), frameDuration: { value: '1', timescale: '30' },
    occurrences: [
      { id: 'clip', name: 'Opening', startTime: time('0'), durationTime: time('3'), sourceStartTime: time('1'), track: 0, role: 'video', mediaId: 'a' },
      { id: 'music', name: 'Music', startTime: time('0'), durationTime: time('3'), sourceStartTime: time('0'), track: 1, role: 'music', mediaId: 'm' },
    ],
    storyElements: [], markers: [], captions: [],
    titles: [{ id: 'title', text: 'Intro', startTime: time('0'), durationTime: time('1'), lane: 2 }],
  },
  resources: [
    { id: 'a', name: 'interview.mov', mediaKind: 'video', source: '/synthetic/interview.mov', sourceRange: { start: time('0'), duration: time('10') } },
    { id: 'm', name: 'music.wav', mediaKind: 'audio', source: '/synthetic/music.wav', sourceRange: { start: time('0'), duration: time('10') } },
  ],
  revision: { id: 'revision-a', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' },
};

test('synthetic accepted brief and version A stop on independent audio lane during reconciliation', async () => {
  // This is synthetic acceptance, not a user approval or source-byte validation.
  const accepted = acceptCreativeBrief(brief);
  assertBriefBinding(accepted, brief);
  assert.equal(accepted.digest, 'd0f69a740d3cf55e8d2281b075f2a4c39d7a16db28d39b60054c4b41d63e6619');
  const artifact = compileTimelineIrToFcpxml(timeline, { target });
  assert.equal(artifact.destination.mode, 'versioned');
  assert.equal(artifact.digest, '36876dc7558d5dc7b2f0008e14bce44b21e91060a248d8af20eb79aefdf2bfaa');
  assert.equal(artifact.destination.projectUid, 'project-framekit-8b68711b3f');
  assert.match(artifact.xml, /Intro/);
  assert.match(artifact.xml, /music\.wav/);
  const before = createTimelineIrFromProjectSnapshot(FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/generated.fcpxml', artifact.xml));
  const ours = structuredClone(before);
  ours.sequence.occurrences[0]!.name = 'Agent rename';
  const externalXml = await readFile('scripts/research/revision-roundtrip/independent-edited.fcpxml', 'utf8');
  assert.equal(hash(externalXml), 'f718297ef52cf7741d55b6ce25906fdc873013f625b40a5c33a1148fcbb85e0e');
  const snapshot = FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/edited.fcpxml', externalXml);
  assert.equal(snapshot.projectId, 'fcpxml:project:project-framekit-8b68711b3f');
  assert.deepEqual(snapshot.timeline.clips.map(clip => [clip.name, clip.mediaId, clip.track]), [
    ['Opening', 'a', 0], ['m', 'm', -1], ['Closing', 'a', 0],
  ]);
  assert.deepEqual(snapshot.timeline.clips.map(clip => [clip.startTime, clip.durationTime, clip.sourceStartTime]), [
    [time('0'), time('1'), time('1')], [time('1'), time('2'), time('0')], [time('1'), time('2'), time('3')],
  ]);
  assert.deepEqual(snapshot.timeline.frameDuration, { value: '1', timescale: '30' });
  assert.ok(snapshot.timeline.storyElements.some(element => element.kind === 'title' && element.text === 'Intro'));
  const theirs = createTimelineIrFromProjectSnapshot(snapshot);
  theirs.revision = { id: 'synthetic-external', sequence: 1, timestamp: '2026-01-02T00:00:00.000Z' };
  const result = reconcileTimelineIr({ base: before, ours, theirs });
  assert.equal(result.status, 'conflicted');
  assert.equal(result.merged, undefined);
  assert.ok(result.conflicts.some(conflict => conflict.kind === 'invalid-state' && conflict.path.endsWith('.track')));
});
