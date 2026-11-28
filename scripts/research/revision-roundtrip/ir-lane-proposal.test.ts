import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FcpxmlDocumentAdapter, compileTimelineIrToFcpxml } from '@framekit/final-cut/fcpxml';
import { createTimelineIrFromProjectSnapshot } from '@framekit/runtime';
import { XMLParser } from 'fast-xml-parser';

const target = { provider: 'final-cut' as const, libraryUid: 'library', eventUid: 'event', projectUid: 'project', sequenceUid: 'sequence' };

test('fixture-only signed lane remap exposes compiler representation changes', async () => {
  const source = await readFile('scripts/research/revision-roundtrip/independent.fcpxml', 'utf8');
  const original = new XMLParser({ ignoreAttributes: false }).parse(source).fcpxml.library.event.project.sequence.spine['asset-clip'];
  assert.equal(original['@_offset'], '0s');
  assert.equal(original['@_start'], '1s');
  assert.equal(original.audio['@_offset'], '1s');
  assert.equal(original.audio['@_lane'], '-1');
  const snapshot = FcpxmlDocumentAdapter.readProjectFromContent('/synthetic/independent.fcpxml', source);
  const timeline = createTimelineIrFromProjectSnapshot(snapshot);
  const primary = timeline.sequence.occurrences.find(clip => clip.mediaId === 'a')!;
  const audio = timeline.sequence.occurrences.find(clip => clip.mediaId === 'm')!;
  assert.equal(audio.track, -1);
  assert.equal(audio.attachedTo, undefined);
  // Supplied by the fixture, not inferred from the imported IR.
  audio.track = 1;
  audio.startTime = { value: '0', timescale: '1' };
  audio.attachedTo = primary.id;
  timeline.sequence.storyElements = [];
  const artifact = compileTimelineIrToFcpxml(timeline, { target });
  const xml = new XMLParser({ ignoreAttributes: false }).parse(artifact.xml);
  const spine = xml.fcpxml.library.event.project.sequence.spine;
  const video = Array.isArray(spine['asset-clip']) ? spine['asset-clip'][0] : spine['asset-clip'];
  assert.equal(video.audio, undefined);
  assert.equal(video['asset-clip']['@_lane'], '1');
  assert.equal(video['asset-clip']['@_name'], 'm');
  // The imported audio offset is in the parent clip's source time domain.
  // Original: parent offset 0 + child offset 1 - parent start 1 = 0 s.
  // Recompiled: parent offset 0 + child offset 0 - parent start 1 = -1 s.
  assert.equal(video['@_offset'], '0s');
  assert.equal(video['@_start'], '1s');
  assert.equal(video['asset-clip']['@_offset'], '0s');
});
