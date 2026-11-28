import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileTimelineIrToFcpxml, FcpxmlDocumentAdapter } from "@framekit/final-cut/fcpxml";
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
  assert.ok(artifact.coverage.degraded.includes("title-position-roundtrip-unverified"));
  const portrait = fixture(); portrait.resources[0]!.metadata!.streams[0]!.width = 1080; portrait.resources[0]!.metadata!.streams[0]!.height = 1920;
  assert.match(compileTimelineIrToFcpxml(portrait, { target }).xml, /<adjust-transform position="14\.0625 -25"\s*\/>/);
  const center = fixture(); center.sequence.titles![0]!.position = { x: 0, y: 0 };
  assert.match(compileTimelineIrToFcpxml(center, { target }).xml, /<adjust-transform position="0 0"\s*\/>/);
  assert.ok(!artifact.coverage.exact.includes("native-title-position"));
  const mixed = fixture();
  mixed.sequence.durationTime = { value: "3", timescale: "1" };
  mixed.resources.push({ ...structuredClone(mixed.resources[0]!), id: "second", name: "Second", metadata: { durationTime: { value: "2", timescale: "1" }, streams: [{ kind: "video", width: 640, height: 480, frameRate: { value: "30", timescale: "1" } }] } });
  mixed.sequence.occurrences.push({ ...structuredClone(mixed.sequence.occurrences[0]!), id: "second-clip", mediaId: "second", startTime: { value: "2", timescale: "1" }, durationTime: { value: "1", timescale: "1" } });
  assert.throws(() => compileTimelineIrToFcpxml(mixed, { target }), /FCPXML_TITLE_POSITION_FORMAT_AMBIGUOUS/);
  mixed.resources[1]!.metadata!.streams[0]!.width = 1920; mixed.resources[1]!.metadata!.streams[0]!.height = 1080;
  assert.match(compileTimelineIrToFcpxml(mixed, { target }).xml, /<adjust-transform position="44\.444444 -25"\s*\/>/);
  const noDimensions = fixture();
  delete noDimensions.resources[0]!.metadata!.streams[0]!.width;
  delete noDimensions.resources[0]!.metadata!.streams[0]!.height;
  assert.throws(() => compileTimelineIrToFcpxml(noDimensions, { target }), /FCPXML_TITLE_POSITION_DIMENSIONS_UNAVAILABLE/);
  const styled = fixture(); styled.sequence.titles![0]!.style = { color: "red" };
  assert.throws(() => compileTimelineIrToFcpxml(styled, { target }), /FCPXML_UNSUPPORTED_TIMELINE_FEATURE/);
});


test("positioned title export conforms to the installed FCPXML DTD", { skip: !existsSync("/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd") }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-positioned-title-"));
  try {
    const path = join(dir, "positioned.fcpxml");
    await writeFile(path, compileTimelineIrToFcpxml(fixture(), { target }).xml);
    execFileSync("xmllint", ["--noout", "--dtdvalid", pathToFileURL("/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd").href, path]);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(snapshot.timeline.storyElements.find((item) => item.kind === "title")?.position, { x: 44.444444, y: -25 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("positioned title export reports missing dimensions on any primary source", () => {
  for (const streams of [[{ kind: "video" as const, frameRate: { value: "30", timescale: "1" } }], [{ kind: "audio" as const, sampleRate: 48000, channels: 2 }]]) {
    const timeline = fixture();
    timeline.sequence.durationTime = { value: "3", timescale: "1" };
    timeline.resources.push({ ...structuredClone(timeline.resources[0]!), id: "second", metadata: { durationTime: { value: "2", timescale: "1" }, streams } });
    timeline.sequence.occurrences.push({ ...structuredClone(timeline.sequence.occurrences[0]!), id: "second-clip", mediaId: "second", startTime: { value: "2", timescale: "1" }, durationTime: { value: "1", timescale: "1" } });
    assert.throws(() => compileTimelineIrToFcpxml(timeline, { target }), /FCPXML_TITLE_POSITION_DIMENSIONS_UNAVAILABLE/);
  }
});
