import assert from "node:assert/strict";
import test from "node:test";
import * as runtimeApi from "@framekit/runtime";
import type { ProjectSnapshot } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

type RoughCutPlanRequest = {
  baseRevision: ProjectSnapshot["revision"];
  imports?: Array<{
    type: "media.import";
    mediaId: string;
    source: string;
    mediaKind: "video" | "audio";
    duration: number;
    sourceDigest: string;
  }>;
  shots: Array<{ occurrenceId: string; mediaId: string; duration?: number }>;
};

const planRoughCut = (runtimeApi as unknown as {
  planRoughCut: (snapshot: ProjectSnapshot, request: RoughCutPlanRequest) => {
    projectId: string;
    timelineId: string;
    duration: number;
    operations: unknown[];
  };
}).planRoughCut;

function emptyProject(): ProjectSnapshot {
  return {
    projectId: "project-rough-cut",
    projectName: "Rough Cut Fixture",
    timeline: {
      id: "timeline-rough-cut",
      name: "Main Cut",
      duration: 3,
      durationTime: { value: "3", timescale: "1" },
      clips: [{
        id: "existing-clip",
        name: "Existing",
        start: 0,
        duration: 3,
        track: 0,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "3", timescale: "1" },
      }],
      storyElements: [{
        id: "existing-clip",
        kind: "asset-clip",
        start: 0,
        duration: 3,
        lane: 0,
      }],
      markers: [],
      captions: [],
    },
    media: [{
      mediaId: "existing-media",
      source: "/fixtures/existing.mov",
      mediaKind: "video",
      duration: 3,
    }],
    revision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function request(baseRevision: ProjectSnapshot["revision"]): RoughCutPlanRequest {
  return {
    baseRevision,
    imports: [
      {
        type: "media.import",
        mediaId: "media-a",
        source: "/fixtures/a.mov",
        mediaKind: "video",
        duration: 6,
        sourceDigest: "sha256:a",
      },
      {
        type: "media.import",
        mediaId: "media-b",
        source: "/fixtures/b.mov",
        mediaKind: "video",
        duration: 4,
        sourceDigest: "sha256:b",
      },
    ],
    shots: [
      { occurrenceId: "shot-a", mediaId: "media-a", duration: 5 },
      { occurrenceId: "shot-b", mediaId: "media-b" },
    ],
  };
}

function runtime() {
  return new runtimeApi.AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-rough-cut",
    projectName: "Rough Cut Fixture",
    timelineId: "timeline-rough-cut",
    timelineName: "Main Cut",
    clips: [{ id: "existing-clip", name: "Existing", start: 0, duration: 3, track: 0 }],
    media: [{ mediaId: "existing-media", source: "/fixtures/existing.mov", mediaKind: "video", duration: 3 }],
  }));
}

test("rough-cut planner emits deterministic imports and sequential primary shots", () => {
  const before = emptyProject();
  const first = planRoughCut(before, request(before.revision));
  const second = planRoughCut(before, request(before.revision));

  assert.deepEqual(first, second);
  assert.deepEqual(first.operations, [
    {
      type: "media.import",
      mediaId: "media-a",
      source: "/fixtures/a.mov",
      mediaKind: "video",
      duration: 6,
      sourceDigest: "sha256:a",
    },
    {
      type: "media.import",
      mediaId: "media-b",
      source: "/fixtures/b.mov",
      mediaKind: "video",
      duration: 4,
      sourceDigest: "sha256:b",
    },
    {
      type: "timeline.media.add",
      occurrenceId: "shot-a",
      mediaId: "media-a",
      role: "video",
      start: 3,
      duration: 5,
      targetLane: "primary",
    },
    {
      type: "timeline.media.add",
      occurrenceId: "shot-b",
      mediaId: "media-b",
      role: "video",
      start: 8,
      duration: 4,
      targetLane: "primary",
    },
  ]);
  assert.equal(first.projectId, "project-rough-cut");
  assert.equal(first.timelineId, "timeline-rough-cut");
  assert.equal(first.duration, 12);
});

test("runtime rough-cut planning is read-only and binds the base revision", async () => {
  const active = runtime();
  const before = await active.inspectProject();

  const plan = await (active as unknown as {
    planRoughCut: (value: RoughCutPlanRequest) => Promise<{ baseRevision: ProjectSnapshot["revision"] }>;
  }).planRoughCut(request(before.revision));

  assert.equal(plan.baseRevision.id, before.revision.id);
  assert.deepEqual(await active.inspectProject(), before);
});

test("rough-cut planner rejects missing, non-video, and overlong shots", () => {
  const before = emptyProject();

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    shots: [{ occurrenceId: "missing", mediaId: "not-found" }],
  }), /MEDIA_NOT_FOUND/);

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    imports: [{
      type: "media.import",
      mediaId: "audio-only",
      source: "/fixtures/audio.wav",
      mediaKind: "audio",
      duration: 5,
      sourceDigest: "sha256:audio",
    }],
    shots: [{ occurrenceId: "audio-shot", mediaId: "audio-only" }],
  }), /ROUGH_CUT_VIDEO_REQUIRED/);

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    imports: [{
      type: "media.import",
      mediaId: "short",
      source: "/fixtures/short.mov",
      mediaKind: "video",
      duration: 2,
      sourceDigest: "sha256:short",
    }],
    shots: [{ occurrenceId: "too-long", mediaId: "short", duration: 3 }],
  }), /ROUGH_CUT_DURATION_EXCEEDS_SOURCE/);
});
