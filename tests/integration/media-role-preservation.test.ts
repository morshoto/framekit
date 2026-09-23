import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, type WorkflowOperation } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createRoleRuntime() {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-media-roles",
    projectName: "Media Role Fixture",
    timelineId: "timeline-media-roles",
    timelineName: "Main Edit",
    clips: [],
    media: [
      {
        mediaId: "media-video",
        source: "/fixtures/video.mov",
        mediaKind: "video",
        duration: 10,
        sourceDigest: "sha256:video",
      },
      {
        mediaId: "media-audio",
        source: "/fixtures/audio.wav",
        mediaKind: "audio",
        duration: 10,
        sourceDigest: "sha256:audio",
      },
      {
        mediaId: "media-music",
        source: "/fixtures/music.wav",
        mediaKind: "audio",
        duration: 10,
        sourceDigest: "sha256:music",
      },
    ],
  });
  return new AgentVideoRuntime(adapter);
}

function mediaAddOperations(): WorkflowOperation[] {
  return [
    {
      type: "timeline.media.add",
      occurrenceId: "clip-video",
      mediaId: "media-video",
      role: "video",
      start: 0,
      duration: 2,
      targetLane: "primary",
    },
    {
      type: "timeline.media.add",
      occurrenceId: "clip-audio",
      mediaId: "media-audio",
      role: "audio",
      start: 0,
      duration: 2,
      targetLane: -1,
    },
    {
      type: "timeline.media.add",
      occurrenceId: "clip-music",
      mediaId: "media-music",
      role: "music",
      start: 0,
      duration: 2,
      targetLane: -2,
    },
  ];
}

test("media additions preserve video, audio, and music roles in canonical clips", async () => {
  const runtime = createRoleRuntime();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: mediaAddOperations(),
  });

  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    transaction.after.timeline.clips.map(({ id, role, track }) => ({ id, role, track })),
    [
      { id: "clip-video", role: "video", track: 0 },
      { id: "clip-audio", role: "audio", track: -1 },
      { id: "clip-music", role: "music", track: -2 },
    ],
  );
});

test("music clips reject moves to the primary storyline", async () => {
  const runtime = createRoleRuntime();
  const before = await runtime.inspectProject();
  const addPreview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [mediaAddOperations()[2]!],
  });
  await runtime.executeEdit(addPreview.previewToken);
  const beforeMove = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewEdit({
      baseRevision: beforeMove.revision,
      operations: [{
        type: "timeline.media.move",
        occurrenceId: "clip-music",
        start: 1,
        targetLane: "primary",
      }],
    }),
    /INVALID_OPERATION: audio and title clips require a non-primary lane/,
  );
  assert.deepEqual(await runtime.inspectProject(), beforeMove);
});
