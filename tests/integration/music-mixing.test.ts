import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createMusicRuntime() {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-music",
    projectName: "Music Mixing Fixture",
    timelineId: "timeline-music",
    timelineName: "Main Edit",
    clips: [{
      id: "clip-dialogue",
      mediaId: "media-dialogue",
      name: "Dialogue",
      start: 0,
      duration: 8,
      track: 1,
    }],
    media: [{
      mediaId: "media-dialogue",
      source: "dialogue.wav",
      mediaKind: "audio",
      duration: 8,
      audio: { integratedLufs: -18, truePeakDb: -3, silenceMs: 0 },
    }],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter) };
}

test("music workflow previews, mixes, verifies, and undoes an appended music bed", async () => {
  const { runtime } = createMusicRuntime();
  const before = await runtime.inspectProject();

  const preview = await runtime.previewMusic({
    baseRevision: before.revision,
    occurrenceId: "clip-music",
    import: {
      mediaId: "media-music",
      source: "/fixtures/music-bed.wav",
      duration: 6,
      sourceDigest: "sha256:music-bed",
    },
    placement: "append",
    duration: 6,
    targetLane: -1,
    gainDb: -14,
    fadeIn: 0.5,
    fadeOut: 1,
  });

  assert.deepEqual(await runtime.inspectProject(), before);
  assert.equal(preview.expectedDiff.added[0]?.itemId, "clip-music");
  assert.equal(preview.expectedDiff.mediaChanges[0]?.media.mediaId, "media-music");
  assert.equal(preview.operations.length, 4);

  const transaction = await runtime.executeEdit(preview.previewToken);
  const music = transaction.after.timeline.clips.find((clip) => clip.id === "clip-music");

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(music?.start, 8);
  assert.equal(music?.duration, 6);
  assert.equal(music?.track, -1);
  assert.equal(music?.gainDb, -14);
  assert.equal(music?.fadeIn, 0.5);
  assert.equal(music?.fadeOut, 1);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "audio-state" && check.passed), true);

  const restored = await runtime.undo(transaction.id);
  assert.deepEqual(restored.timeline.clips, before.timeline.clips);
  assert.deepEqual(restored.media, before.media);
});
