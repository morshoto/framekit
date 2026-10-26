import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FcpxmlDocumentAdapter, verifyFinalCutPublishReadback } from "@framekit/final-cut";
import type { Clip, ProjectSnapshot, RationalTime, StoryElement } from "@framekit/runtime";

const rate = (frames: number): RationalTime => ({ value: String(frames), timescale: "24" });

function makeSnapshot(
  prefix: string,
  resourceIds: { a: string; b: string; c: string; music: string },
  mediaDirectory = "/tmp",
): ProjectSnapshot {
  const sources = [
    { mediaId: resourceIds.a, source: `${mediaDirectory}/clip-a.mp4`, mediaKind: "video" as const, duration: 24 },
    { mediaId: resourceIds.b, source: `${mediaDirectory}/clip-b.mp4`, mediaKind: "video" as const, duration: 15 },
    { mediaId: resourceIds.c, source: `${mediaDirectory}/clip-c.mp4`, mediaKind: "video" as const, duration: 14 },
    { mediaId: resourceIds.music, source: `${mediaDirectory}/generated-music.wav`, mediaKind: "audio" as const, duration: 30 },
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
  const approved = makeSnapshot("approved", { a: "r1", b: "r2", c: "r3", music: "r4" }, "/tmp/approved-media");
  const native = makeSnapshot("native", { a: "asset-8", b: "asset-3", c: "asset-9", music: "asset-6" }, "/tmp/new-library/Original Media");
  native.timeline.duration = 30.01;
  native.timeline.durationTime = { value: "3001", timescale: "100" };
  native.timeline.clips.find(({ role }) => role === "music")!.track = -2;
  native.timeline.storyElements.find(({ kind, mediaId }) => kind === "audio" && mediaId === "asset-6")!.lane = -2;

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

test("Final Cut XML keeps nested title text and audio-only media identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-fcpxml-readback-"));
  const path = join(directory, "native.fcpxml");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><resources>
  <format id="r1" name="FFVideoFormat720p30" frameDuration="1/30s" width="1280" height="720" />
  <asset id="r2" name="clip.mp4" src="file:///tmp/Original%20Media/clip.mp4" duration="12s" hasVideo="1" hasAudio="1" format="r1" />
  <asset id="r3" name="generated-music.wav" src="file:///tmp/Original%20Media/generated-music.wav" duration="30s" hasAudio="1" />
  <effect id="r4" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti" />
</resources><library><event><project uid="native-project" name="Native project"><sequence uid="native-sequence" name="Native sequence" format="r1" duration="30s"><spine>
  <asset-clip name="Clip" ref="r2" offset="0s" start="0s" duration="12s"><title name="Issue title" ref="r4" offset="0s" duration="6s" lane="1"><text><text-style ref="ts1">FrameKit MVP Test</text-style></text></title><asset-clip name="Music" ref="r3" offset="0s" duration="30s" lane="-2" audioRole="music"><adjust-volume amount="-12dB" /></asset-clip></asset-clip>
</spine></sequence></project></event></library></fcpxml>`;
  try {
    await writeFile(path, xml, "utf8");
    const snapshot = await new FcpxmlDocumentAdapter(path, undefined, {
      allowMissingImmutableIdsForReadback: true,
    }).readProject();

    assert.equal(snapshot.timeline.storyElements.find(({ kind }) => kind === "title")?.text, "FrameKit MVP Test");
    assert.equal(snapshot.media.find(({ mediaId }) => mediaId === "r3")?.mediaKind, "audio");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
