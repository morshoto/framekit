import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { FcpxmlDocumentAdapter } from '@framekit/final-cut/fcpxml';
import { createFramekitRenderPlan, createFramekitRenderRequest, createTimelineIrFromProjectSnapshot } from '@framekit/runtime';
import { FfmpegTimelineRenderer } from '../../../adapters/headless/typescript/src/index.js';

const run = promisify(execFile);

test('characterizes headless render boundary for anchored synthetic revision B', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'framekit-b-characterization-'));
  try {
    const output = join(directory, 'b.fcpxml');
    await run(process.execPath, ['scripts/research/revision-roundtrip/run-anchored-handoff.mjs', output]);
    const verified = await run('python3', ['scripts/research/revision-roundtrip/verify-anchored.py', output]);
    assert.match(verified.stdout, /manifest verified/);
    const snapshot = FcpxmlDocumentAdapter.readProjectFromContent(output, await readFile(output, 'utf8'));
    const audio = snapshot.timeline.clips.find(clip => clip.track === -1);
    assert.ok(audio);
    assert.deepEqual(audio.startTime, { value: '2', timescale: '1' });
    assert.equal(audio.attachedTo, undefined);
    const timeline = createTimelineIrFromProjectSnapshot(snapshot);
    assert.throws(() => createFramekitRenderRequest({ timeline,
      target: { projectId: timeline.project.id, sequenceId: timeline.sequence.id },
      parameters: { outputPath: join(directory, 'unused.mp4'), format: 'mp4', width: 320, height: 180, frameRate: { value: '30', timescale: '1' } },
    }), /TIMELINE_IR_INVALID.*track must be a non-negative integer/);
    // Bounded diagnostic only: retain the known attachment and corrected
    // position explicitly; this is not a general XML-to-IR conversion.
    const proposed = structuredClone(timeline);
    const audioIr = proposed.sequence.occurrences.find(occurrence => occurrence.id === audio.id);
    assert.ok(audioIr);
    audioIr.track = 1;
    audioIr.startTime = { value: '0', timescale: '1' };
    audioIr.attachedTo = 'opening-v1';
    const request = createFramekitRenderRequest({ timeline: proposed,
      target: { projectId: proposed.project.id, sequenceId: proposed.sequence.id },
      parameters: { outputPath: join(directory, 'unused.mp4'), format: 'mp4', width: 320, height: 180, frameRate: { value: '30', timescale: '1' } },
    });
    const renderer = new FfmpegTimelineRenderer();
    const capabilities = renderer.capabilities(request);
    assert.equal(capabilities.features['structural-edits'], 'unsupported');
    assert.throws(() => createFramekitRenderPlan(request, capabilities), /RENDER_CAPABILITY_UNAVAILABLE/);
    const withoutStories = structuredClone(proposed);
    withoutStories.sequence.storyElements = [];
    const check = (candidate: typeof proposed) => renderer.capabilities(createFramekitRenderRequest({ timeline: candidate,
      target: { projectId: candidate.project.id, sequenceId: candidate.sequence.id },
      parameters: { outputPath: join(directory, 'unused.mp4'), format: 'mp4', width: 320, height: 180, frameRate: { value: '30', timescale: '1' } },
    })).features['structural-edits'];
    assert.equal(check(withoutStories), 'unsupported');
    const detached = structuredClone(withoutStories);
    delete detached.sequence.occurrences.find(occurrence => occurrence.id === audio.id)!.attachedTo;
    assert.equal(check(detached), 'supported');

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
