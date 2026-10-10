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
  libraryUid: "library-1",
  eventUid: "event-1",
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
  assert.match(first.xml, /<project uid="project-1-framekit-[a-f0-9]{10}" name="Project \(Framekit revision-1-4-[a-f0-9]{10}\)">/);
  assert.match(first.xml, /<sequence uid="sequence-1-framekit-[a-f0-9]{10}" name="Main \(Framekit revision-1-4-[a-f0-9]{10}\)"/);
  assert.equal(first.destination.mode, "versioned");
  assert.notEqual(first.destination.projectUid, target.projectUid);
  assert.deepEqual(first.target, target);
  assert.deepEqual(first.resourceIds, { "media-1": "resource-media-1" });
  assert.deepEqual(first.coverage, {
    exact: ["artifact", "captions", "gain", "markers", "primary-storyline-order", "project", "provenance", "resources", "roles", "sequence", "source-ranges", "versioned-destination"],
    degraded: [],
    unsupported: [],
  });
  assert.deepEqual(first.provenance, {
    source: "framekit-timeline-ir",
    schemaVersion: 1,
    projectId: "project-1",
    sequenceId: "sequence-1",
    revision: timeline().revision,
    timelineDigest: first.provenance.timelineDigest,
    target: {
      libraryUid: "library-1",
      eventUid: "event-1",
      projectUid: "project-1",
      sequenceUid: "sequence-1",
    },
    destination: {
      projectUid: first.destination.projectUid,
      sequenceUid: first.destination.sequenceUid,
    },
  });
  assert.match(first.provenance.timelineDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.provenance, second.provenance);
});

test("compiles an opening Timeline IR title as editable Final Cut text", async () => {
  const value = timeline();
  value.sequence.occurrences = [{
    ...value.sequence.occurrences[0]!,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    sourceStartTime: { value: "0", timescale: "1" },
  }];
  value.sequence.storyElements = [];
  value.sequence.titles = [{
    id: "opening-title",
    text: "FrameKit MVP Test",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "6", timescale: "1" },
    lane: 1,
  }];

  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-title-"));
  const path = join(directory, "opening.fcpxml");
  try {
    const artifact = compileTimelineIrToFcpxml(value, { target });
    assert.match(artifact.xml, /<effect id="effect-basic-title" name="Basic Title" uid="\.\.\.\/Titles\.localized\/Bumper:Opener\.localized\/Basic Title\.localized\/Basic Title\.moti" \/>/);
    assert.match(artifact.xml, /<title id="opening-title" ref="effect-basic-title" name="opening-title" offset="0s" duration="6s" lane="1">\s*<text>FrameKit MVP Test<\/text>\s*<\/title>/);
    assert.deepEqual(artifact.coverage.degraded, []);
    assert.deepEqual(artifact.coverage.unsupported, []);

    await writeFile(path, artifact.xml, "utf8");
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(
      readback.timeline.storyElements.filter(({ kind }) => kind === "title").map(({ text, start, duration, lane }) => ({ text, start, duration, lane })),
      [{ text: "FrameKit MVP Test", start: 0, duration: 6, lane: 1 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("anchors titles after a primary clip source in-point", async () => {
  const value = timeline();
  value.sequence.occurrences = [{
    ...value.sequence.occurrences[0]!,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    sourceStartTime: { value: "5", timescale: "1" },
  }];
  value.sequence.storyElements = [];
  value.sequence.titles = [{
    id: "trimmed-opening-title",
    text: "Trimmed source title",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "6", timescale: "1" },
    lane: 1,
  }];

  const artifact = compileTimelineIrToFcpxml(value, { target });

  assert.match(artifact.xml, /<asset-clip id="occurrence-1"[^>]*start="5s"[^>]*>[\s\S]*?<title id="trimmed-opening-title"[^>]*offset="5s"/);

  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-trimmed-title-"));
  const path = join(directory, "trimmed-title.fcpxml");
  try {
    await writeFile(path, artifact.xml, "utf8");
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(
      readback.timeline.storyElements.filter(({ kind }) => kind === "title").map(({ start, duration }) => ({ start, duration })),
      [{ start: 0, duration: 6 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves embedded video audio and a separate music asset in FCPXML", async () => {
  const value = timeline();
  value.sequence.occurrences = [{
    ...value.sequence.occurrences[0]!,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    sourceStartTime: { value: "0", timescale: "1" },
  }, {
    id: "music-bed",
    name: "Music bed",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    sourceStartTime: { value: "0", timescale: "1" },
    track: 1,
    role: "music",
    mediaId: "music-1",
    gainDb: -12,
  }];
  value.sequence.storyElements = [];
  value.resources[0]!.metadata = {
    durationTime: { value: "10", timescale: "1" },
    streams: [
      { kind: "video", width: 1920, height: 1080, frameRate: { value: "30", timescale: "1" } },
      { kind: "audio", sampleRate: 48_000, channels: 1 },
    ],
  };
  value.resources.push({
    id: "music-1",
    name: "licensed-music.wav",
    mediaKind: "audio",
    source: "/media/licensed-music.wav",
    metadata: {
      durationTime: { value: "10", timescale: "1" },
      streams: [{ kind: "audio", sampleRate: 48_000, channels: 1 }],
    },
  });

  const artifact = compileTimelineIrToFcpxml(value, { target });

  assert.match(artifact.xml, /name="opening\.mov" src="file:\/\/\/media\/opening\.mov" hasVideo="1" hasAudio="1" \/>/);
  assert.match(artifact.xml, /name="licensed-music\.wav" src="file:\/\/\/media\/licensed-music\.wav" hasVideo="0" hasAudio="1" \/>/);
  assert.match(artifact.xml, /<asset-clip id="music-bed"[^>]+audioRole="music">/);
  assert.doesNotMatch(artifact.xml, /<asset-clip id="music-bed"[^>]+\srole="music"/);
  assert.match(artifact.xml, /<adjust-volume amount="-12dB" \/>/);

  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-music-role-"));
  const path = join(directory, "music-role.fcpxml");
  try {
    await writeFile(path, artifact.xml, "utf8");
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.equal(readback.timeline.clips.find(({ id }) => id === "music-bed")?.role, "music");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizes versioned destination IDs without regex backtracking", () => {
  const result = compileTimelineIrToFcpxml(timeline(), {
    target: {
      ...target,
      projectUid: " --project.! name-- ",
      sequenceUid: " --sequence.! name-- ",
    },
  });

  assert.match(result.destination.projectUid, /^project-name-framekit-[a-f0-9]{10}$/);
  assert.match(result.destination.sequenceUid, /^sequence-name-framekit-[a-f0-9]{10}$/);
});

test("binds versioned destination identities to the canonical revision", () => {
  const nextRevision = timeline();
  nextRevision.revision = { ...nextRevision.revision, id: "revision-2", sequence: 5 };
  const first = compileTimelineIrToFcpxml(timeline(), { target });
  const second = compileTimelineIrToFcpxml(nextRevision, { target });

  assert.notEqual(first.destination.projectUid, second.destination.projectUid);
  assert.notEqual(first.destination.sequenceUid, second.destination.sequenceUid);
  assert.notEqual(first.destination.projectName, second.destination.projectName);
  assert.equal(first.coverage.exact.includes("versioned-destination"), true);
  assert.equal(compileTimelineIrToFcpxml(timeline(), { target: { ...target, materialization: "reuse-existing" } }).coverage.exact.includes("versioned-destination"), false);
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
    /FCPXML_UNSUPPORTED_TIMELINE_FEATURE: story-element:title/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      resources: [{ ...timeline().resources[0]!, mediaKind: "unknown" }],
    }, { target }),
    /FCPXML_UNSUPPORTED_RESOURCE_KIND: unknown/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      sequence: {
        ...timeline().sequence,
        occurrences: [
          ...timeline().sequence.occurrences,
          {
            id: "occurrence-2",
            name: "Closing",
            startTime: { value: "3003", timescale: "24000" },
            durationTime: { value: "1001", timescale: "24000" },
            track: 0,
            role: "video",
            mediaId: "media-1",
          },
        ],
        transitions: [{
          id: "transition-1",
          kind: "cross-dissolve",
          beforeOccurrenceId: "occurrence-1",
          afterOccurrenceId: "occurrence-2",
          durationTime: { value: "1", timescale: "30" },
        }],
      },
    }, { target }),
    /FCPXML_UNSUPPORTED_TIMELINE_FEATURE: transitions/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      sequence: { ...timeline().sequence, occurrences: [{ ...timeline().sequence.occurrences[0]!, transform: { scaleX: 0.5, scaleY: 0.5 } }] },
    }, { target }),
    /FCPXML_UNSUPPORTED_TIMELINE_FEATURE: transforms/,
  );
  assert.throws(
    () => compileTimelineIrToFcpxml({
      ...timeline(),
      sequence: {
        ...timeline().sequence,
        storyElements: [{
          id: "linked-title",
          kind: "title",
          occurrenceId: "occurrence-1",
          startTime: { value: "1001", timescale: "24000" },
          durationTime: { value: "1001", timescale: "24000" },
        }],
      },
    }, { target }),
    /FCPXML_UNSUPPORTED_TIMELINE_FEATURE: story-element:title/,
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
