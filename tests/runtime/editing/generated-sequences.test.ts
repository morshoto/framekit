import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  AgentVideoRuntime, FramekitProjectStore, ProjectTransactionService,
  type FramekitProjectDocument, type ProjectEditCommand, type ProjectStoreFileSystem, type RationalTime,
} from '@framekit/runtime';
import { InMemoryEditorAdapter } from '@framekit/testkit';
import { FcpxmlDocumentAdapter } from '@framekit/final-cut';

// Integer ticks are the independent oracle: no runtime arithmetic, codecs or
// digest helpers construct the expected results. Replay any seed via this env.
const seeds = process.env.FRAMEKIT_TEST_SEED ? [Number(process.env.FRAMEKIT_TEST_SEED)] : [733, 1001, 24000, 0x5eed];
function random(seed: number) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'FRAMEKIT_TEST_SEED must be a uint32');
  let state = seed >>> 0;
  return () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
}
const time = (ticks: number): RationalTime => ({ value: String(ticks), timescale: '24000' });
function ticks(actual: RationalTime | undefined, expected: number) {
  assert.ok(actual);
  assert.equal(BigInt(actual.value) * 24000n, BigInt(expected) * BigInt(actual.timescale));
}
function initial(seed: number): FramekitProjectDocument {
  return { schemaVersion: 1, metadata: { createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }, timeline: {
    schemaVersion: 1, project: { id: `project-${seed}`, name: 'Generated' },
    sequence: { id: 'sequence', name: 'Generated', durationTime: time(240000), frameDuration: time(1001),
      occurrences: [{ id: 'clip', name: 'Original', startTime: time(0), durationTime: time(240000), sourceStartTime: time(1001), track: 0, mediaId: 'media', binding: { provider: 'fixture', kind: 'occurrence', identity: 'source-occurrence' } }],
      storyElements: [], markers: [], captions: [] },
    resources: [{ id: 'media', name: 'Source', mediaKind: 'video', source: '/fixtures/generated.mov', sourceKind: 'local-file', sourceDigest: 'a'.repeat(64), binding: { provider: 'fixture', kind: 'resource', identity: 'source-resource' } }],
    revision: { id: 'revision-0', sequence: 0, timestamp: '2026-10-05T00:00:00.000Z' },
  } };
}

for (const seed of seeds) test(`seed ${seed}: generated transactions preserve persistence, rational time and source identity`, async t => {
  const next = random(seed), trace: unknown[] = [];
  const root = await mkdtemp(join(tmpdir(), 'framekit-generated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project.json');
  let fault: 'write' | 'rename' | undefined;
  const fs: ProjectStoreFileSystem = {
    mkdir: async (p, options) => { await mkdir(p, options); }, readFile,
    writeFile: async (p, data, options) => { if (fault === 'write' && p.endsWith('.tmp')) throw Error('injected write'); await writeFile(p, data, options); },
    link,
    rename: async (a, b) => { if (fault === 'rename') throw Error('injected rename'); await rename(a, b); },
    unlink: async p => { await rm(p, { force: true }); },
  };
  const store = new FramekitProjectStore(path, fs);
  const original = initial(seed); await store.create(original);
  const service = new ProjectTransactionService(store, { clock: () => '2026-10-05T00:01:00.000Z' });
  let revision = 0;
  const model = [{ id: 'clip', name: 'Original', start: 0, duration: 240000, source: 1001, track: 0, bound: true }];
  try {
    for (let step = 0; step < 40; step++) {
      const mode = step < 8 ? step : next() % 8;
      const selected = model[next() % model.length]!;
      const current = await store.load(), bytes = await readFile(path, 'utf8');
      const command: ProjectEditCommand = { schemaVersion: 1, target: { projectId: current.timeline.project.id, sequenceId: 'sequence' }, expectedRevision: current.timeline.revision,
        operations: [{ type: 'rename-occurrence', occurrenceId: selected.id, name: `Name ${next()}` }] };
      if (mode === 1) command.operations = [{ type: 'trim-occurrence', occurrenceId: selected.id, durationTime: time(1001 * (1 + next() % 10)), sourceStartTime: time(next() % 1001) }];
      if (mode === 2) command.operations = [{ type: 'move-occurrence', occurrenceId: selected.id, startTime: time(next() % 24000), track: next() % 3 }];
      if (mode === 3 && selected.duration > 1 && model.length < 10) command.operations = [{ type: 'split-occurrence', occurrenceId: selected.id, splitOffsetTime: time(Math.floor(selected.duration / 2)), newOccurrenceId: `right-${step}` }];
      if (mode === 4) {
        // Revision identity is ID + sequence; timestamps are informational.
        const field = ['id', 'sequence'][next() % 2]!;
        command.expectedRevision = { ...command.expectedRevision, [field]: field === 'sequence' ? revision + 1 : 'stale' };
      }
      if (mode === 5) command.operations.push({ type: 'rename-occurrence', occurrenceId: 'missing', name: 'Must not partially persist' });
      if (mode === 6) command.operations = [{ type: 'insert-occurrence', occurrence: { id: `invalid-${step}`, name: 'Unbound', startTime: time(0), durationTime: time(1001), track: 0, mediaId: 'unknown-source' } }];
      if (mode === 7) fault = next() % 2 ? 'write' : 'rename';
      trace.push({ step, mode, fault, command });
      if (mode >= 4) {
        await assert.rejects(service.execute(command), error => {
          const code = (error as { code: string }).code;
          return code === (mode === 4 ? 'PROJECT_EDIT_STALE_REVISION' : mode === 7 ? 'PROJECT_SAVE_FAILED' : 'PROJECT_EDIT_INVALID');
        });
        fault = undefined;
        assert.equal(await readFile(path, 'utf8'), bytes, 'rejection cannot alter canonical bytes');
        assert.deepEqual(await new FramekitProjectStore(path).load(), current);
        continue;
      }
      const preview = await service.preview(command);
      assert.equal(await readFile(path, 'utf8'), bytes, 'preview cannot persist');
      const result = await service.execute(command);
      const op = command.operations[0]!;
      if (op.type === 'rename-occurrence') selected.name = op.name;
      if (op.type === 'trim-occurrence') { selected.duration = Number(op.durationTime.value); selected.source = Number(op.sourceStartTime!.value); }
      if (op.type === 'move-occurrence') { selected.start = Number(op.startTime.value); selected.track = op.track!; }
      if (op.type === 'split-occurrence') {
        const offset = Number(op.splitOffsetTime.value);
        model.push({ ...selected, id: op.newOccurrenceId, start: selected.start + offset, duration: selected.duration - offset, source: selected.source + offset, bound: false });
        selected.duration = offset;
      }
      revision++;
      const persisted = await new FramekitProjectStore(path).load();
      assert.deepEqual(persisted, result.after);
      assert.deepEqual(preview.after.timeline.sequence, persisted.timeline.sequence);
      assert.equal(persisted.timeline.revision.sequence, revision, 'one successful commit advances once');
      assert.deepEqual(persisted.timeline.resources, original.timeline.resources, 'editing cannot relabel source identity');
      assert.equal(persisted.timeline.sequence.occurrences.length, model.length);
      for (const expected of model) {
        const actual = persisted.timeline.sequence.occurrences.find(clip => clip.id === expected.id)!;
        assert.equal(actual.name, expected.name); assert.equal(actual.mediaId, 'media'); assert.equal(actual.track, expected.track);
        ticks(actual.startTime, expected.start); ticks(actual.durationTime, expected.duration); ticks(actual.sourceStartTime, expected.source);
        assert.equal(Boolean(actual.binding), expected.bound, 'new split occurrence cannot inherit the provider binding');
      }
      ticks(persisted.timeline.sequence.durationTime, Math.max(...model.map(clip => clip.start + clip.duration)));
    }
  } catch (error) {
    t.diagnostic(`Replay: FRAMEKIT_TEST_SEED=${seed} pnpm test --file tests/runtime/editing/generated-sequences.test.ts`);
    t.diagnostic(JSON.stringify({ seed, operations: trace }));
    throw error;
  }
});

for (const seed of seeds) test(`seed ${seed}: supported execute and Undo restore independent fixture content`, async t => {
  const next = random(seed);
  const adapter = new InMemoryEditorAdapter({ projectId: 'generated-undo', projectName: 'Generated Undo', timelineId: 'timeline', timelineName: 'Timeline',
    clips: [{ id: 'clip', mediaId: 'media', name: 'Original', start: 0, duration: 10, track: 0 }],
    media: [{ mediaId: 'media', source: '/fixtures/source.mov', sourceDigest: 'sha256:source', mediaKind: 'video', duration: 10 }] });
  const runtime = new AgentVideoRuntime(adapter);
  for (let step = 0; step < 12; step++) {
    const before = await runtime.inspectProject();
    const operation = next() % 2 ? { type: 'rename-clip' as const, clipId: 'clip', name: `Name ${next()}` } : { type: 'trim-clip' as const, clipId: 'clip', duration: 1 + next() % 9 };
    const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: [operation] });
    assert.deepEqual(await runtime.inspectProject(), before);
    const result = await runtime.executeEdit(preview.previewToken);
    assert.equal(result.status, 'VERIFIED');
    const clip = result.after.timeline.clips[0]!;
    assert.equal(clip.name, operation.type === 'rename-clip' ? operation.name : 'Original');
    assert.equal(clip.duration, operation.type === 'trim-clip' ? operation.duration : 10);
    assert.equal(result.after.revision.sequence, before.revision.sequence + 1);
    const restored = await runtime.undo(result.id);
    assert.deepEqual(restored.timeline, before.timeline, `seed=${seed} step=${step}`);
    assert.deepEqual(restored.media, before.media);
    assert.equal(restored.revision.sequence, result.after.revision.sequence + 1);
  }
});

for (const seed of seeds) test(`seed ${seed}: artifact source changes reject execution without overwriting external bytes`, async t => {
  const next = random(seed);
  const root = await mkdtemp(join(tmpdir(), 'framekit-generated-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project.fcpxml');
  for (let step = 0; step < 6; step++) {
    const content = `<fcpxml version="1.11"><resources/><library><event><project uid="project" name="Original"><sequence uid="sequence" duration="1s"><spine><asset-clip id="clip" name="Original" offset="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>`;
    await writeFile(path, content);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewArtifactEdit(path, { baseRevision: before.revision, operations: [{ type: 'rename-clip', clipId: 'clip', name: 'Must not apply' }] });
    const external = content.replace('name="Original"', `name="External ${next()}"`) + `\n<!-- seed=${seed} step=${step} -->`;
    await writeFile(path, external);
    await assert.rejects(runtime.executeEdit(preview.previewToken), /ARTIFACT_SOURCE_CHANGED/);
    assert.equal(await readFile(path, 'utf8'), external);
  }
});
