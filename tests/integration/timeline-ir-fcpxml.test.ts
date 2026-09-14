import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FcpxmlDocumentAdapter,
  compileTimelineIrToFcpxml,
  type TimelineIrToFcpxmlTarget,
} from "@framekit/final-cut";
import type { TimelineIr } from "@framekit/runtime";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1001", timescale: "24000" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "1001", timescale: "24000" },
        durationTime: { value: "2002", timescale: "24000" },
        sourceStartTime: { value: "1001", timescale: "48000" },
        track: 0,
        role: "video",
        mediaId: "media-1",
        gainDb: -3,
      }],
      storyElements: [{
        id: "gap-1",
        kind: "gap",
        startTime: { value: "3003", timescale: "24000" },
        durationTime: { value: "1001", timescale: "24000" },
      }],
      markers: [{
        id: "marker-1",
        name: "Review & approve",
        startTime: { value: "1001", timescale: "24000" },
        durationTime: { value: "0", timescale: "1" },
      }],
      captions: [{
        id: "caption-1",
        text: "Hello <world>",
        startTime: { value: "2002", timescale: "24000" },
        durationTime: { value: "1001", timescale: "24000" },
      }],
    },
    resources: [{
      id: "media-1",
      name: "opening.mov",
      mediaKind: "video",
      source: "/media/opening.mov",
    }],
    revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-14T00:00:00.000Z" },
  };
}

const target: TimelineIrToFcpxmlTarget = {
  provider: "final-cut",
  projectUid: "project-1",
  sequenceUid: "sequence-1",
  eventName: "Framekit Event",
};

test("compiles Timeline IR to deterministic versioned FCPXML with exact times", () => {
  const first = compileTimelineIrToFcpxml(timeline(), { target });
  const second = compileTimelineIrToFcpxml(timeline(), { target });

  assert.equal(first.version, "1.11");
  assert.equal(first.xml, second.xml);
  assert.equal(first.digest, second.digest);
  assert.match(first.xml, /<fcpxml version="1\.11">/);
  assert.match(first.xml, /frameDuration="1001\/24000s"/);
  assert.match(first.xml, /offset="1001\/24000s"/);
  assert.match(first.xml, /start="1001\/48000s"/);
  assert.match(first.xml, /value="Review &amp; approve"/);
  assert.match(first.xml, /text="Hello &lt;world&gt;"/);
  assert.match(first.xml, /<project uid="project-1-framekit-[a-f0-9]{10}" name="Project \(Framekit [a-f0-9]{10}\)">/);
  assert.match(first.xml, /<sequence uid="sequence-1-framekit-[a-f0-9]{10}" name="Main \(Framekit [a-f0-9]{10}\)"/);
  assert.equal(first.destination.mode, "versioned");
  assert.notEqual(first.destination.projectUid, target.projectUid);
  assert.deepEqual(first.target, target);
  assert.deepEqual(first.resourceIds, { "media-1": "resource-media-1" });
});

test("emits connected elements with parent-relative exact offsets", () => {
  const value = timeline();
  value.sequence.occurrences.push({
    id: "occurrence-child",
    name: "Connected",
    startTime: { value: "2002", timescale: "24000" },
    durationTime: { value: "1001", timescale: "24000" },
    track: 1,
    role: "video",
    mediaId: "media-1",
    attachedTo: "occurrence-1",
    gainDb: -1,
  });

  const xml = compileTimelineIrToFcpxml(value, { target }).xml;
  const parentStart = xml.indexOf('id="occurrence-1"');
  const childStart = xml.indexOf('id="occurrence-child"');
  assert.ok(parentStart >= 0 && childStart > parentStart);
  assert.equal(xml.slice(childStart).match(/offset="([^"]+)"/)?.[1], "1001/24000s");
});

test("requires an explicit Final Cut target and fails closed for unsupported IR", () => {
  assert.throws(
    () => compileTimelineIrToFcpxml(timeline(), { target: { ...target, projectUid: "" } }),
    /FCPXML_TARGET_BINDING_INVALID/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      sequence: { ...timeline().sequence, storyElements: [{
        id: "title-1",
        kind: "title",
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "1", timescale: "1" },
      }] },
    }, { target }),
    /FCPXML_UNSUPPORTED_STORY_ELEMENT: title/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      resources: [{ ...timeline().resources[0]!, mediaKind: "unknown" }],
    }, { target }),
    /FCPXML_UNSUPPORTED_RESOURCE_KIND: unknown/,
  );
});

test("requires explicit opt-in before reusing the supplied project identity", () => {
  const artifact = compileTimelineIrToFcpxml(timeline(), {
    target: { ...target, materialization: "reuse-existing" },
  });

  assert.equal(artifact.destination.mode, "reuse-existing");
  assert.match(artifact.xml, /<project uid="project-1" name="Project">/);
  assert.match(artifact.xml, /<sequence uid="sequence-1" name="Main"/);
});

test("round-trips compiled FCPXML through the existing document adapter", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-timeline-ir-fcpxml-"));
  const path = join(directory, "compiled.fcpxml");
  try {
    const artifact = compileTimelineIrToFcpxml(timeline(), { target });
    await writeFile(path, artifact.xml, "utf8");

    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();

    assert.equal(snapshot.projectName, artifact.destination.projectName);
    assert.equal(snapshot.timeline.name, artifact.destination.sequenceName);
    assert.deepEqual(snapshot.timeline.frameDuration, { value: "1001", timescale: "24000" });
    assert.deepEqual(snapshot.timeline.clips[0]?.startTime, { value: "1001", timescale: "24000" });
    assert.deepEqual(snapshot.timeline.clips[0]?.durationTime, { value: "1001", timescale: "12000" });
    assert.deepEqual(snapshot.timeline.clips[0]?.sourceStartTime, { value: "1001", timescale: "48000" });
    assert.equal(snapshot.timeline.clips[0]?.mediaId, "resource-media-1");
    assert.equal(snapshot.timeline.clips[0]?.gainDb, -3);
    assert.equal(snapshot.timeline.markers[0]?.name, "Review & approve");
    assert.equal(snapshot.timeline.captions[0]?.text, "Hello <world>");
    assert.equal(snapshot.timeline.storyElements.some(({ id }) => id === "gap-1"), true);
    assert.equal((await readFile(path, "utf8")).includes("<fcpxml version=\"1.11\">"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
