import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTimelineIrToFcpxml } from "@framekit/final-cut/fcpxml";
import type { TimelineIr } from "@framekit/runtime";

const target = { provider: "final-cut" as const, libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" };
function fixture(): TimelineIr {
  return { schemaVersion: 1, project: { id: "project", name: "Project" }, sequence: { id: "sequence", name: "Main",
    durationTime: { value: "2", timescale: "1" }, frameDuration: { value: "1", timescale: "30" },
    occurrences: [{ id: "clip", name: "Clip", mediaId: "video", role: "video", track: 0,
      startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" } }],
    titles: [{ id: "caption", text: "Hello", lane: 1, startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, position: { x: 0.5, y: -0.5 } }],
    storyElements: [], markers: [], captions: [] }, resources: [{ id: "video", name: "Video", mediaKind: "video", source: "/media/video.mov",
      metadata: { durationTime: { value: "2", timescale: "1" }, streams: [{ kind: "video", width: 1920, height: 1080, frameRate: { value: "30", timescale: "1" } }] } }],
    revision: { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00Z" } };
}

test("positioned titles export height-normalized transforms with explicit native limits", () => {
  const value = fixture();
  const artifact = compileTimelineIrToFcpxml(value, { target });
  assert.match(artifact.xml, /<adjust-transform position="44\.444444 -25"\s*\/>/);
  assert.ok(artifact.coverage.degraded.includes("native-title-position-unverified"));
  assert.ok(!artifact.coverage.exact.includes("native-title-position"));
  const noDimensions = fixture();
  delete noDimensions.resources[0]!.metadata!.streams[0]!.width;
  delete noDimensions.resources[0]!.metadata!.streams[0]!.height;
  assert.throws(() => compileTimelineIrToFcpxml(noDimensions, { target }), /FCPXML_TITLE_POSITION_DIMENSIONS_UNAVAILABLE/);
  const styled = fixture(); styled.sequence.titles![0]!.style = { color: "red" };
  assert.throws(() => compileTimelineIrToFcpxml(styled, { target }), /FCPXML_UNSUPPORTED_TIMELINE_FEATURE/);
});
