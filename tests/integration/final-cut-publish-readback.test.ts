import assert from "node:assert/strict";
import test from "node:test";
import { verifyFinalCutPublishReadback } from "@framekit/final-cut";
import type { Clip, ProjectSnapshot, RationalTime, StoryElement } from "@framekit/runtime";

const rate = (frames: number): RationalTime => ({ value: String(frames), timescale: "24" });

function makeSnapshot(prefix: string, resourceIds: { a: string; b: string; c: string; music: string }): ProjectSnapshot {
  const sources = [
    { mediaId: resourceIds.a, source: "/tmp/clip-a.mp4", mediaKind: "video" as const, duration: 24 },
    { mediaId: resourceIds.b, source: "/tmp/clip-b.mp4", mediaKind: "video" as const, duration: 15 },
    { mediaId: resourceIds.c, source: "/tmp/clip-c.mp4", mediaKind: "video" as const, duration: 14 },
    { mediaId: resourceIds.music, source: "/tmp/generated-music.wav", mediaKind: "audio" as const, duration: 30 },
  ];
  const clips: Clip[] = [
    { id: `${prefix}-b`, mediaId: resourceIds.b, name: "Clip B", start: 0, duration: 8, sourceStart: 5, sourceStartTime: rate(120), track: 0, role: "video", startTime: rate(0), durationTime: rate(192) },
    { id: `${prefix}-a`, mediaId: resourceIds.a, name: "Clip A", start: 8, duration: 12, sourceStart: 10, sourceStartTime: rate(240), track: 0, role: "video", startTime: rate(192), durationTime: rate(288) },
    { id: `${prefix}-c`, mediaId: resourceIds.c, name: "Clip C", start: 20, duration: 10, sourceStart: 2, sourceStartTime: rate(48), track: 0, role: "video", startTime: rate(480), durationTime: rate(240) },
    { id: `${prefix}-music`, mediaId: resourceIds.music, name: "Generated Music", start: 0, duration: 30, sourceStart: 0, sourceStartTime: rate(0), track: 2, gainDb: -12, role: "music", startTime: rate(0), durationTime: rate(720) },
  ];
  const storyElements: StoryElement[] = [
    { id: `${prefix}-b`, kind: "asset-clip", start: 0, duration: 8, startTime: rate(0), durationTime: rate(192), mediaId: resourceIds.b },
    { id: `${prefix}-title`, kind: "title", start: 0, duration: 6, startTime: rate(0), durationTime: rate(144), lane: 1, text: "FrameKit MVP Test" },
    { id: `${prefix}-music`, kind: "audio", start: 0, duration: 30, startTime: rate(0), durationTime: rate(720), lane: 2, mediaId: resourceIds.music },
    { id: `${prefix}-a`, kind: "asset-clip", start: 8, duration: 12, startTime: rate(192), durationTime: rate(288), mediaId: resourceIds.a },
    { id: `${prefix}-c`, kind: "asset-clip", start: 20, duration: 10, startTime: rate(480), durationTime: rate(240), mediaId: resourceIds.c },
  ];

  return {
    projectId: `${prefix}-project`,
    projectName: "FrameKit MVP Test v1",
    timeline: {
      id: `${prefix}-sequence`,
      name: "FrameKit MVP Test v1",
      duration: 30,
      durationTime: rate(720),
      frameDuration: rate(1),
      clips,
      storyElements,
      markers: [],
      captions: [],
    },
    media: sources,
    revision: { id: `${prefix}-revision`, sequence: prefix === "approved" ? 1 : 9, timestamp: new Date(0).toISOString() },
  };
}

test("native publish readback accepts the exact approved edit across native-generated IDs", () => {
  const approved = makeSnapshot("approved", { a: "r1", b: "r2", c: "r3", music: "r4" });
  const native = makeSnapshot("native", { a: "asset-8", b: "asset-3", c: "asset-9", music: "asset-6" });

  const evidence = verifyFinalCutPublishReadback(approved, native);

  assert.equal(evidence.verified, true);
  assert.deepEqual(evidence.checked, [
    "project-and-sequence-names",
    "timeline-duration-and-frame-rate",
    "clip-order-and-source-ranges",
    "editable-title-content-and-timing",
    "connected-audio-source-role-gain-and-timing",
    "other-timeline-elements",
    "markers-and-captions",
    "source-media-bindings",
  ]);
  assert.equal(evidence.expectedDigest, evidence.observedDigest);
});

test("native publish readback rejects a changed trim", () => {
  const approved = makeSnapshot("approved", { a: "r1", b: "r2", c: "r3", music: "r4" });
  const native = makeSnapshot("native", { a: "asset-8", b: "asset-3", c: "asset-9", music: "asset-6" });
  native.timeline.clips[0]!.sourceStartTime = rate(96);

  assert.throws(
    () => verifyFinalCutPublishReadback(approved, native),
    /FINAL_CUT_PUBLISH_SEMANTIC_MISMATCH:.*clip-order-and-source-ranges/,
  );
});

test("native publish readback rejects a changed title and music binding", () => {
  const approved = makeSnapshot("approved", { a: "r1", b: "r2", c: "r3", music: "r4" });
  const native = makeSnapshot("native", { a: "asset-8", b: "asset-3", c: "asset-9", music: "asset-6" });
  native.timeline.storyElements[1]!.text = "Different title";
  native.media.find((item) => item.mediaId === "asset-6")!.source = "/tmp/other-music.wav";

  assert.throws(
    () => verifyFinalCutPublishReadback(approved, native),
    /FINAL_CUT_PUBLISH_SEMANTIC_MISMATCH:.*editable-title-content-and-timing.*connected-audio-source-role-gain-and-timing.*source-media-bindings/,
  );
});
