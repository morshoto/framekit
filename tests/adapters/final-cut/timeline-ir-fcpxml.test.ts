import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  FcpxmlDocumentAdapter,
  compileTimelineIrToFcpxml,
  type TimelineIrToFcpxmlTarget,
} from "@framekit/final-cut/fcpxml";
import { createTimelineIrFromProjectSnapshot, validateTimelineIr, type TimelineIr } from "@framekit/runtime";
import { planFcpxmlDissolve } from "../../../adapters/final-cut/typescript/src/fcpxml-transition-plan.js";

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
        id: "review-42",
        name: "Review & approve",
        startTime: { value: "1001", timescale: "24000" },
        durationTime: { value: "0", timescale: "1" },
      }],
      captions: [{
        id: "subtitle-abc",
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
      metadata: {
        durationTime: { value: "24", timescale: "1" },
        streams: [
          { kind: "video", width: 1280, height: 720, frameRate: { value: "24", timescale: "1" }, color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } },
          { kind: "audio", channels: 2, sampleRate: 48000 },
        ],
      },
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

test("native dissolve readback preserves visible semantics without inventing stripped IDs", () => {
  // Final Cut's exported XML retains effect references and timing but strips
  // Framekit's custom metadata; identifiers below are native document IDs.
  const xml = `<?xml version="1.0"?><fcpxml version="1.11"><resources>
    <format id="r1" name="FFVideoFormat720p30" frameDuration="1/30s" width="1280" height="720"/>
    <asset id="r2" name="red.mp4" start="0s" duration="2s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///media/red.mp4"/></asset>
    <asset id="r3" name="blue.mp4" start="0s" duration="2s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///media/blue.mp4"/></asset>
    <effect id="r4" name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>
    <effect id="r5" name="Audio Crossfade" uid="FFAudioTransition"/>
    <effect id="r6" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>
    </resources><library><event name="Event"><project name="Native" uid="native-project"><sequence format="r1" duration="2s"><spine>
    <asset-clip ref="r2" name="Red" offset="0s" start="1/5s" duration="9/10s"/>
    <transition name="Cross Dissolve" offset="4/5s" duration="1/5s"><filter-video ref="r4"/><filter-audio ref="r5"/></transition>
    <asset-clip ref="r3" name="Blue" offset="9/10s" start="2/5s" duration="11/10s"><title ref="r6" lane="1" offset="3/10s" name="title" duration="1/6s"><text><text-style ref="ts1">FADE</text-style></text><text-style-def id="ts1"><text-style font="Helvetica" fontSize="63"/></text-style-def></title></asset-clip>
    </spine></sequence></project></event></library></fcpxml>`;
  const snapshot = FcpxmlDocumentAdapter.readProjectFromContent("/media/native.fcpxml", xml);
  const transition = snapshot.timeline.storyElements.find((element) => element.kind === "transition")!;
  const title = snapshot.timeline.storyElements.find((element) => element.kind === "title")!;
  assert.equal(transition.assetId, "fcpxml:effect:FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265");
  assert.deepEqual(transition.startTime, { value: "4", timescale: "5" });
  assert.deepEqual(transition.durationTime, { value: "1", timescale: "5" });
  assert.equal(transition.transitionKind, undefined);
  assert.equal(transition.beforeClipId, undefined);
  assert.equal(transition.afterClipId, undefined);
  assert.equal(title.text, "FADE");
  assert.deepEqual(title.startTime, { value: "4", timescale: "5" });
  assert.deepEqual(title.durationTime, { value: "1", timescale: "6" });
  const readback = createTimelineIrFromProjectSnapshot(snapshot);
  assert.equal(readback.sequence.transitions, undefined);
  assert.ok(readback.sequence.storyElements.some((element) => element.kind === "transition"));
});

test("dissolve plans preserve source frames across rates and odd durations", () => {
  for (const [rate, scale] of [[24, 1], [25, 1], [30, 1], [30000, 1001]] as const) {
    for (const transitionFrames of [1, 2, 3, 5, 6, 15]) {
      const value = timeline();
      const frameTime = (frames: number) => ({ value: String(frames * scale), timescale: String(rate) });
      const frames = (time: { value: string; timescale: string }) => {
        const n = BigInt(time.value) * BigInt(rate), d = BigInt(time.timescale) * BigInt(scale);
        assert.equal(n % d, 0n, `unaligned plan time at ${rate}/${scale}`);
        return Number(n / d);
      };
      value.sequence.frameDuration = frameTime(1);
      value.resources[0]!.metadata!.streams[0]!.frameRate = { value: String(rate), timescale: String(scale) };
      value.resources[0]!.metadata!.streams[1]!.channels = 1;
      value.sequence.occurrences = [
        { id: "before", name: "Before", mediaId: "media-1", role: "video", track: 0, startTime: frameTime(0), sourceStartTime: frameTime(0), durationTime: frameTime(60) },
        { id: "after", name: "After", mediaId: "media-1", role: "video", track: 0, startTime: frameTime(60), sourceStartTime: frameTime(120), durationTime: frameTime(60) },
      ];
      value.sequence.transitions = [{ id: "fade", kind: "cross-dissolve", beforeOccurrenceId: "before", afterOccurrenceId: "after", durationTime: frameTime(transitionFrames) }];
      const plan = planFcpxmlDissolve(value);
      assert.equal(frames(plan.startTime), 60 - transitionFrames);
      assert.equal(frames(plan.durationTime), transitionFrames);
      assert.equal(frames(plan.beforeDurationTime), frames(plan.afterStartTime));
      for (const timelineFrame of [60 - transitionFrames, 59, 60, 61, 89, 119]) {
        const nativeSourceFrame = frames(plan.afterSourceStartTime) + timelineFrame - frames(plan.afterStartTime);
        assert.equal(nativeSourceFrame, 120 + timelineFrame - 60, `incoming source drift at ${rate}/${scale}, ${transitionFrames} frames`);
      }
      assert.equal(frames(plan.afterStartTime) + frames(plan.afterDurationTime), 120);
    }
  }
});

test("exports an adjacent cross-dissolve with its media references", async () => {
  const value = timeline();
  value.sequence.frameDuration = { value: "1", timescale: "30" };
  value.sequence.durationTime = { value: "4", timescale: "1" };
  value.sequence.storyElements = [];
  value.sequence.markers = [];
  value.sequence.captions = [];
  value.sequence.occurrences = [
    { id: "before", name: "Before", startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "1", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
    { id: "after", name: "After", startTime: { value: "2", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "4", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
  ];
  value.sequence.transitions = [{ id: "dissolve", kind: "cross-dissolve", beforeOccurrenceId: "before", afterOccurrenceId: "after", durationTime: { value: "1", timescale: "2" } }];
  value.resources[0]!.metadata!.streams[0]!.frameRate = { value: "30", timescale: "1" };
  value.resources[0]!.metadata!.streams[1]!.channels = 1;
  value.sequence.occurrences.push({ id: "music", name: "Music", startTime: { value: "1", timescale: "2" }, durationTime: { value: "3", timescale: "1" }, sourceStartTime: { value: "1", timescale: "1" }, track: 1, role: "music", mediaId: "music-source", gainDb: -12 });
  value.sequence.titles = [{ id: "title-over-dissolve", text: "Blend", startTime: { value: "3", timescale: "2" }, durationTime: { value: "1", timescale: "2" }, lane: 2 }];
  value.resources.push({ id: "music-source", name: "music.wav", mediaKind: "audio", source: "/media/music.wav", metadata: { durationTime: { value: "10", timescale: "1" }, streams: [{ kind: "audio", channels: 1, sampleRate: 48000 }] } });

  const plan = planFcpxmlDissolve(value);
  assert.deepEqual(plan, { id: "dissolve", beforeId: "before", afterId: "after", startTime: { value: "3", timescale: "2" }, durationTime: { value: "1", timescale: "2" }, beforeDurationTime: { value: "53", timescale: "30" }, afterStartTime: { value: "53", timescale: "30" }, afterSourceStartTime: { value: "113", timescale: "30" }, afterDurationTime: { value: "67", timescale: "30" } });
  const tooShort = structuredClone(value);
  tooShort.sequence.occurrences[1]!.durationTime = { value: "3", timescale: "10" };
  assert.throws(() => planFcpxmlDissolve(tooShort), /FCPXML_DISSOLVE_DURATION/);
  const noHandle = structuredClone(value);
  noHandle.sequence.occurrences[1]!.sourceStartTime = { value: "0", timescale: "1" };
  assert.throws(() => planFcpxmlDissolve(noHandle), /FCPXML_.*handle/i);
  assert.throws(() => compileTimelineIrToFcpxml(noHandle, { target }), /FCPXML_.*handle/i);
  const incompatibleRate = structuredClone(value);
  incompatibleRate.resources[0]!.metadata!.streams[0]!.frameRate = { value: "24", timescale: "1" };
  assert.throws(() => planFcpxmlDissolve(incompatibleRate), /FCPXML_.*frame.rate/i);
  const missingRate = structuredClone(value);
  delete missingRate.resources[0]!.metadata!.streams[0]!.frameRate;
  assert.throws(() => planFcpxmlDissolve(missingRate), /FCPXML_.*frame.rate/i);
  const unalignedBefore = structuredClone(value);
  unalignedBefore.sequence.occurrences[0]!.sourceStartTime = { value: "1", timescale: "60" };
  assert.throws(() => planFcpxmlDissolve(unalignedBefore), /FCPXML_DISSOLVE_FRAME_ALIGNMENT/);
  const unaligned = structuredClone(value);
  unaligned.sequence.transitions![0]!.durationTime = { value: "1", timescale: "7" };
  assert.throws(() => planFcpxmlDissolve(unaligned), /FCPXML_.*frame/i);
  assert.throws(() => compileTimelineIrToFcpxml(unaligned, { target }), /FCPXML_.*frame/i);
  const result = compileTimelineIrToFcpxml(value, { target });
  assert.match(result.xml, /<transition\b/);
  assert.match(result.xml, /duration="1\/2s"/);
  assert.ok(result.xml.indexOf('name="Before"') < result.xml.indexOf("<transition"));
  assert.ok(result.xml.indexOf("<transition") < result.xml.indexOf('name="After"'));
  assert.match(result.xml, /<effect[^>]*name="Cross Dissolve"[^>]*uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/);
  assert.match(result.xml, /<transition[^>]*offset="3\/2s"[^>]*duration="1\/2s"/);
  assert.match(result.xml, /<asset-clip[^>]*name="After"[^>]*offset="53\/30s"[^>]*start="113\/30s"[^>]*duration="67\/30s"/);
  assert.match(result.xml, /<filter-video[^>]*ref="effect-cross-dissolve"/);
  for (const [name, key, value] of [["Look", "1", "11 (Video)"], ["Amount", "2", "50"], ["Ease", "50", "2 (In &amp; Out)"], ["Ease Amount", "51", "0"]]) {
    assert.ok(result.xml.includes(`<param name="${name}" key="${key}" value="${value}" />`), `missing explicit ${name} parameter`);
  }
  assert.match(result.xml, /<effect[^>]*name="Audio Crossfade"[^>]*uid="FFAudioTransition"/);
  assert.match(result.xml, /<filter-audio[^>]*ref="effect-audio-crossfade"/);
  assert.match(result.xml, /<asset[^>]*hasAudio="1"/);
  assert.match(result.xml, /<asset-clip[^>]*name="Music"[^>]*offset="3\/2s"[^>]*start="1s"[^>]*duration="3s"/);
  assert.match(result.xml, /<adjust-volume amount="-12dB"/);
  assert.match(result.xml, /name="After"[^>]*>[\s\S]*?<title[^>]*name="title-over-dissolve"[^>]*offset="7\/2s"[^>]*duration="1\/2s"/);
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-dissolve-dtd-"));
  try {
    const path = join(directory, "timeline.fcpxml");
    await writeFile(path, result.xml);
    validateWithInstalledFinalCut(path);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    const before = snapshot.timeline.clips.find((clip) => clip.id === "before");
    const after = snapshot.timeline.clips.find((clip) => clip.id === "after");
    const transition = snapshot.timeline.storyElements.find((item) => item.id === "dissolve");
    const title = snapshot.timeline.storyElements.find((item) => item.id === "title-over-dissolve");
    assert.ok(title);
    assert.equal(title.start, 1.5);
    assert.equal(title.duration, 0.5);
    assert.ok(before && after && transition);
    assert.equal(transition.kind, "transition");
    assert.equal(transition.assetId, "fcpxml:effect:FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265");
    assert.equal(transition.start, 1.5);
    assert.equal(transition.duration, 0.5);
    assert.ok(Math.abs(before.start + before.duration - 53 / 30) < 1e-9);
    assert.ok(Math.abs(after.start - 53 / 30) < 1e-9);
    assert.ok(Math.abs(after.start + 7 / 30 - 2) < 1e-9);
    assert.ok(Math.abs(after.sourceStart! + 7 / 30 - 4) < 1e-9);
    assert.ok(Math.abs(after.duration - 7 / 30 - 2) < 1e-9);
    assert.equal(before.mediaId, after.mediaId);
    const reconstructed = createTimelineIrFromProjectSnapshot(snapshot);
    assert.deepEqual(reconstructed.sequence.transitions, [{ id: "dissolve", kind: "cross-dissolve", beforeOccurrenceId: "before", afterOccurrenceId: "after", durationTime: { value: "1", timescale: "2" } }]);
    const incoming = reconstructed.sequence.occurrences.find((item) => item.id === "after");
    assert.deepEqual(incoming?.startTime, { value: "2", timescale: "1" });
    assert.deepEqual(incoming?.sourceStartTime, { value: "4", timescale: "1" });
    assert.deepEqual(incoming?.durationTime, { value: "2", timescale: "1" });
    const incomingStory = reconstructed.sequence.storyElements.find((item) => item.id === "after");
    assert.deepEqual(incomingStory?.startTime, incoming?.startTime);
    assert.deepEqual(incomingStory?.durationTime, incoming?.durationTime);
    validateTimelineIr(reconstructed);
    // A title may begin before the dissolve and extend past the shortened
    // outgoing FCPXML clip. Its original timeline interval must survive.
    const crossing = structuredClone(value);
    crossing.sequence.titles![0]!.startTime = { value: "7", timescale: "5" };
    crossing.sequence.titles![0]!.durationTime = { value: "1", timescale: "2" };
    const crossingXml = compileTimelineIrToFcpxml(crossing, { target }).xml;
    assert.match(crossingXml, /name="Before"[^>]*>[\s\S]*?<title[^>]*name="title-over-dissolve"[^>]*offset="12\/5s"[^>]*duration="1\/2s"/);
    const crossingPath = join(directory, "crossing.fcpxml");
    await writeFile(crossingPath, crossingXml);
    validateWithInstalledFinalCut(crossingPath);
    const crossingSnapshot = await new FcpxmlDocumentAdapter(crossingPath).readProject();
    const crossingTitle = crossingSnapshot.timeline.storyElements.find((item) => item.id === "title-over-dissolve");
    assert.equal(crossingTitle?.start, 1.4);
    assert.equal(crossingTitle?.duration, 0.5);
    const tampered = structuredClone(snapshot);
    tampered.timeline.storyElements.find((item) => item.id === "dissolve")!.beforeClipId = "missing";
    assert.throws(() => createTimelineIrFromProjectSnapshot(tampered), /TIMELINE_IR_.*transition/i);
    const timingMismatch = structuredClone(snapshot);
    timingMismatch.timeline.clips.find((clip) => clip.id === "after")!.startTime = { value: "4", timescale: "3" };
    assert.throws(() => createTimelineIrFromProjectSnapshot(timingMismatch), /TIMELINE_IR_.*transition/i);
    const invalidPath = join(directory, "invalid.fcpxml");
    await writeFile(invalidPath, result.xml.replace('key="com.framekit.after" value="after"', 'key="com.framekit.other" value="after"'));
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    const contradictory = result.xml.replace('<transition name="Cross Dissolve"', '<transition framekit-before-clip="other" name="Cross Dissolve"');
    await writeFile(invalidPath, contradictory);
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    const duplicate = result.xml.replace('<md key="com.framekit.before" value="before" />', '<md key="com.framekit.before" value="before" /><md key="com.framekit.before" value="other" />');
    await writeFile(invalidPath, duplicate);
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    await writeFile(invalidPath, result.xml.replace('<filter-audio ref="effect-audio-crossfade" name="Audio Crossfade" />', ''));
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    await writeFile(invalidPath, result.xml.replace('uid="FFAudioTransition"', 'uid="unrelated-audio-effect"'));
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    await writeFile(invalidPath, result.xml.replace('<filter-audio ref="effect-audio-crossfade"', '<filter-audio enabled="0" ref="effect-audio-crossfade"'));
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    await writeFile(invalidPath, result.xml.replace('<filter-video ref="effect-cross-dissolve"', '<filter-video enabled="0" ref="effect-cross-dissolve"'));
    await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    for (const altered of [
      result.xml.replace('value="11 (Video)"', 'value="10 (Film)"'),
      result.xml.replace('<param name="Ease Amount" key="51" value="0" />', ''),
      result.xml.replace('<param name="Amount" key="2" value="50" />', '<param name="Amount" key="2" value="50" unexpected="1" />'),
      result.xml.replace('<filter-audio ref="effect-audio-crossfade"', '<reserved/><filter-audio ref="effect-audio-crossfade"'),
    ]) {
      await writeFile(invalidPath, altered);
      await assert.rejects(new FcpxmlDocumentAdapter(invalidPath).readProject(), /FCPXML_TRANSITION_METADATA_INVALID/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dissolve planning rejects unknown or non-BT.709 colors", () => {
  const value = timeline();
  value.sequence.frameDuration = { value: "1", timescale: "30" };
  value.sequence.occurrences = [
    { id: "before", name: "Before", startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "1", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
    { id: "after", name: "After", startTime: { value: "2", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "4", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
  ];
  value.sequence.transitions = [{ id: "dissolve", kind: "cross-dissolve", beforeOccurrenceId: "before", afterOccurrenceId: "after", durationTime: { value: "1", timescale: "2" } }];
  value.resources[0]!.metadata!.streams[0]!.frameRate = { value: "30", timescale: "1" };
  value.resources[0]!.metadata!.streams[1]!.channels = 1;
  assert.doesNotThrow(() => planFcpxmlDissolve(value));
  const thirdClip = structuredClone(value);
  thirdClip.sequence.occurrences.push({ ...thirdClip.sequence.occurrences[1]!, id: "third", startTime: { value: "4", timescale: "1" } });
  assert.throws(() => planFcpxmlDissolve(thirdClip), /FCPXML_DISSOLVE_UNSUPPORTED/);
  const unknown = structuredClone(value);
  delete unknown.resources[0]!.metadata!.streams[0]!.color;
  assert.throws(() => planFcpxmlDissolve(unknown), /FCPXML_DISSOLVE_COLOR_UNSUPPORTED/);
  const wide = structuredClone(value);
  wide.resources[0]!.metadata!.streams[0]!.color!.primaries = "bt2020";
  assert.throws(() => planFcpxmlDissolve(wide), /FCPXML_DISSOLVE_COLOR_UNSUPPORTED/);
  const stereo = structuredClone(value);
  stereo.resources[0]!.metadata!.streams[1]!.channels = 2;
  assert.throws(() => planFcpxmlDissolve(stereo), /FCPXML_DISSOLVE_AUDIO_UNSUPPORTED/);
  const unknownAudio = structuredClone(value);
  delete unknownAudio.resources[0]!.metadata!.streams[1]!.channels;
  assert.throws(() => planFcpxmlDissolve(unknownAudio), /FCPXML_DISSOLVE_AUDIO_UNSUPPORTED/);
  const stereoMusic = structuredClone(value);
  stereoMusic.resources.push({ id: "music", name: "Music", mediaKind: "audio", source: "/media/music.wav", metadata: { durationTime: { value: "4", timescale: "1" }, streams: [{ kind: "audio", channels: 2, sampleRate: 48_000 }] } });
  stereoMusic.sequence.occurrences.push({ id: "music", name: "Music", startTime: { value: "0", timescale: "1" }, durationTime: { value: "4", timescale: "1" }, track: 1, role: "music", mediaId: "music" });
  assert.throws(() => planFcpxmlDissolve(stereoMusic), /FCPXML_DISSOLVE_AUDIO_UNSUPPORTED/);
  const silent = structuredClone(value);
  silent.resources[0]!.metadata!.streams = silent.resources[0]!.metadata!.streams.filter((stream) => stream.kind !== "audio");
  assert.doesNotThrow(() => planFcpxmlDissolve(silent));
  const oneSided = structuredClone(value);
  const silentResource = structuredClone(oneSided.resources[0]!);
  silentResource.id = "silent-media";
  silentResource.metadata!.streams = silentResource.metadata!.streams.filter((stream) => stream.kind !== "audio");
  oneSided.resources.push(silentResource);
  oneSided.sequence.occurrences[1]!.mediaId = silentResource.id;
  assert.throws(() => planFcpxmlDissolve(oneSided), /FCPXML_DISSOLVE_AUDIO_UNSUPPORTED/);
});

test("unverified dissolve export fails closed", () => {
  const value = timeline();
  value.sequence.frameDuration = { value: "1", timescale: "30" };
  value.resources[0]!.metadata!.streams[0]!.frameRate = { value: "30", timescale: "1" };
  value.resources[0]!.metadata!.streams[1]!.channels = 1;
  value.sequence.storyElements = []; value.sequence.markers = []; value.sequence.captions = [];
  value.sequence.occurrences = [
    { id: "a", name: "A", startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "1", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
    { id: "b", name: "B", startTime: { value: "2", timescale: "1" }, durationTime: { value: "2", timescale: "1" }, sourceStartTime: { value: "4", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
  ];
  value.sequence.transitions = [{ id: "t", kind: "cross-dissolve", beforeOccurrenceId: "a", afterOccurrenceId: "b", durationTime: { value: "1", timescale: "2" } }];
  delete value.resources[0]!.metadata!.streams[0]!.color;
  assert.throws(() => compileTimelineIrToFcpxml(value, { target }), /FCPXML_DISSOLVE_COLOR_UNSUPPORTED/);
});

test("dissolve planning preserves fractional frame timing and bounds", async () => {
  const value = timeline();
  value.sequence.frameDuration = { value: "1001", timescale: "30000" };
  value.resources[0]!.metadata!.streams[0]!.frameRate = { value: "30000", timescale: "1001" };
  value.resources[0]!.metadata!.streams[1]!.channels = 1;
  value.sequence.occurrences = [
    { id: "first", name: "First", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1001", timescale: "500" }, sourceStartTime: { value: "0", timescale: "1" }, track: 0, role: "video", mediaId: "media-1" },
    { id: "second", name: "Second", startTime: { value: "1001", timescale: "500" }, durationTime: { value: "1001", timescale: "500" }, sourceStartTime: { value: "3003", timescale: "1000" }, track: 0, role: "video", mediaId: "media-1" },
  ];
  value.sequence.transitions = [{ id: "fade", kind: "cross-dissolve", beforeOccurrenceId: "first", afterOccurrenceId: "second", durationTime: { value: "1001", timescale: "2000" } }];
  const result = planFcpxmlDissolve(value);
  assert.deepEqual(result.startTime, { value: "3003", timescale: "2000" });
  assert.deepEqual(result.afterStartTime, { value: "53053", timescale: "30000" });
  assert.deepEqual(result.afterSourceStartTime, { value: "83083", timescale: "30000" });
  assert.deepEqual(result.afterDurationTime, { value: "67067", timescale: "30000" });
  value.sequence.durationTime = { value: "1001", timescale: "250" };
  value.sequence.storyElements = [];
  value.sequence.markers = [];
  value.sequence.captions = [];
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fractional-dissolve-"));
  try {
    const path = join(directory, "timeline.fcpxml");
    await writeFile(path, compileTimelineIrToFcpxml(value, { target }).xml);
    validateWithInstalledFinalCut(path);
    const reconstructed = createTimelineIrFromProjectSnapshot(await new FcpxmlDocumentAdapter(path).readProject());
    assert.deepEqual(reconstructed.sequence.transitions, value.sequence.transitions);
    const incoming = reconstructed.sequence.occurrences.find((item) => item.id === "second");
    assert.deepEqual(incoming?.startTime, { value: "1001", timescale: "500" });
    assert.deepEqual(incoming?.sourceStartTime, { value: "3003", timescale: "1000" });
    assert.deepEqual(incoming?.durationTime, { value: "1001", timescale: "500" });
    validateTimelineIr(reconstructed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  value.resources[0]!.sourceRange = { start: { value: "3", timescale: "1" }, duration: { value: "10", timescale: "1" } };
  assert.throws(() => planFcpxmlDissolve(value), /FCPXML_DISSOLVE_HANDLE/);
});

test("FCPXML compilation preserves explicit nonzero source bounds", async () => {
  const value = timeline();
  value.resources[0]!.metadata = undefined;
  Object.assign(value.resources[0]!, { sourceRange: { start: { value: "10", timescale: "1" }, duration: { value: "20", timescale: "1" } } });
  value.sequence.occurrences[0]!.sourceStartTime = { value: "15", timescale: "1" };
  const result = compileTimelineIrToFcpxml(value, { target });
  assert.match(result.xml, /<asset\b[^>]*start="10s"[^>]*duration="20s"/);
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-source-bounds-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, result.xml);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(snapshot.media[0]!.sourceRange, { start: { value: "10", timescale: "1" }, duration: { value: "20", timescale: "1" } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML frame rounding cannot move an occurrence outside source bounds", () => {
  const value = timeline();
  value.resources[0]!.metadata = undefined;
  Object.assign(value.resources[0]!, { sourceRange: { start: { value: "10", timescale: "1" }, duration: { value: "2002", timescale: "24000" } } });
  value.sequence.occurrences[0]!.sourceStartTime = { value: "10", timescale: "1" };
  assert.throws(() => compileTimelineIrToFcpxml(value, { target }), /FCPXML_.*SOURCE.*RANGE/i);
});

test("materialization round trips plain dialogue on a video occurrence", async () => {
  const value = timeline();
  value.sequence.markers = [];
  value.sequence.captions = [];
  value.sequence.occurrences[0]!.role = "video";
  value.sequence.occurrences[0]!.nativeAudioRole = "dialogue";
  const result = compileTimelineIrToFcpxml(value, { target });
  assert.match(result.xml, /<asset-clip [^>]*audioRole="dialogue"/);
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-dialogue-video-"));
  const path = join(directory, "dialogue.fcpxml");
  try {
    await writeFile(path, result.xml);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    const clip = snapshot.timeline.clips[0]!;
    assert.equal(clip.nativeAudioRole, "dialogue");
    assert.notEqual(clip.role, "audio");
    assert.equal(snapshot.media.find(({ mediaId }) => mediaId === clip.mediaId)?.mediaKind, "video");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialization retains native dialogue subroles", async () => {
  const value = timeline();
  value.sequence.markers = [];
  value.sequence.captions = [];
  value.sequence.occurrences[0]!.role = "audio";
  value.sequence.occurrences[0]!.nativeAudioRole = "dialogue.dialogue-1";
  value.resources[0]!.mediaKind = "audio";
  value.resources[0]!.metadata = { durationTime: { value: "24", timescale: "1" }, streams: [{ kind: "audio", channels: 2, sampleRate: 48000 }] };
  const result = compileTimelineIrToFcpxml(value, { target });
  assert.match(result.xml, /audioRole="dialogue\.dialogue-1"/);
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-dialogue-role-"));
  const path = join(directory, "role.fcpxml");
  try {
    await writeFile(path, result.xml);
    const snapshot = await new FcpxmlDocumentAdapter(path).readProject();
    assert.equal(snapshot.timeline.clips[0]?.nativeAudioRole, "dialogue.dialogue-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


const finalCutDtd = "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd";

function validateWithInstalledFinalCut(path: string): void {
  if (existsSync(finalCutDtd)) {
    execFileSync("xmllint", ["--noout", "--dtdvalid", pathToFileURL(finalCutDtd).href, path]);
  }
}

test("compiled FCPXML validates against Final Cut's 1.11 DTD", { skip: !existsSync(finalCutDtd) ? "requires installed Final Cut Pro FCPXML 1.11 DTD and xmllint; run on macOS with Final Cut Pro" : false }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-dtd-"));
  const path = join(directory, "timeline.fcpxml");
  try {
    await writeFile(path, compileTimelineIrToFcpxml(timeline(), { target }).xml);
    validateWithInstalledFinalCut(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiles Timeline IR to deterministic versioned FCPXML on the edit frame grid", () => {
  const first = compileTimelineIrToFcpxml(timeline(), { target });
  const second = compileTimelineIrToFcpxml(timeline(), { target });

  assert.equal(first.version, "1.11");
  assert.equal(first.xml, second.xml);
  assert.equal(first.digest, second.digest);
  assert.match(first.xml, /<!DOCTYPE fcpxml>\s*<fcpxml version="1\.11">/);
  assert.match(first.xml, /<fcpxml version="1\.11">/);
  assert.match(first.xml, /frameDuration="1001\/24000s"/);
  assert.match(first.xml, /<format id="r1" name="FFVideoFormat720p2398" frameDuration="1001\/24000s" width="1280" height="720"/);
  assert.match(first.xml, /<format id="format-resource-media-1" name="FFVideoFormat720p24" frameDuration="1\/24s" width="1280" height="720"/);
  assert.match(first.xml, /<asset[^>]*start="0s" duration="24s"[^>]*hasAudio="1"[^>]*audioSources="1" audioChannels="2" audioRate="48000"/);
  assert.match(first.xml, /offset="1001\/24000s"/);
  assert.match(first.xml, /start="1001\/24000s"/);
  assert.match(first.xml, /value="Review &amp; approve"/);
  assert.match(first.xml, /<marker[^>]*note="com\.framekit\.id:review-42"/);
  assert.match(first.xml, /<caption[^>]*>\s*<text>Hello &lt;world&gt;<\/text>\s*<note>com\.framekit\.id:subtitle-abc<\/note>\s*<\/caption>/);
  assert.match(first.xml, /<project uid="project-1-framekit-[a-f0-9]{10}" name="Project \(Framekit revision-1-4-[a-f0-9]{10}\)">/);
  assert.match(first.xml, /<sequence format="r1" duration="10s">/);
  assert.equal(first.destination.sequenceName, first.destination.projectName);
  assert.equal(first.destination.mode, "versioned");
  assert.notEqual(first.destination.projectUid, target.projectUid);
  assert.deepEqual(first.target, target);
  assert.deepEqual(first.resourceIds, { "media-1": "resource-media-1" });
  assert.deepEqual(first.coverage, {
    exact: ["artifact", "captions", "connected-elements", "gain", "markers", "primary-storyline-order", "project", "provenance", "resources", "roles", "sequence", "versioned-destination"],
    degraded: ["video-edit-frame-rounding"],
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

test("uses the first video stream with dimensions for the FCPXML sequence format", () => {
  const value = timeline();
  value.resources[0]!.metadata!.streams = [
    { kind: "video", frameRate: { value: "24", timescale: "1" } },
    { kind: "video", width: 1920, height: 1080, frameRate: { value: "24", timescale: "1" } },
    { kind: "audio", channels: 2, sampleRate: 48000 },
  ];

  const artifact = compileTimelineIrToFcpxml(value, { target });

  assert.match(artifact.xml, /<format id="r1" name="FFVideoFormat1080p2398" frameDuration="1001\/24000s" width="1920" height="1080"/);
});

test("emits a named Final Cut sequence format and frame-aligned video edits", () => {
  const value = timeline();
  value.sequence.frameDuration = { value: "1", timescale: "30" };
  value.sequence.durationTime = { value: "3021", timescale: "100" };
  value.sequence.occurrences = [
    {
      ...value.sequence.occurrences[0]!,
      id: "first-video",
      name: "First video",
      startTime: { value: "0", timescale: "1" },
      durationTime: { value: "423", timescale: "50" },
      sourceStartTime: { value: "249", timescale: "50" },
    },
    {
      ...value.sequence.occurrences[0]!,
      id: "second-video",
      name: "Second video",
      startTime: { value: "423", timescale: "50" },
      durationTime: { value: "1149", timescale: "100" },
      sourceStartTime: { value: "999", timescale: "100" },
    },
    {
      ...value.sequence.occurrences[0]!,
      id: "third-video",
      name: "Third video",
      startTime: { value: "1995", timescale: "100" },
      durationTime: { value: "513", timescale: "50" },
      sourceStartTime: { value: "99", timescale: "50" },
    },
  ];
  value.sequence.storyElements = [];
  value.sequence.markers = [];
  value.sequence.captions = [];
  value.sequence.titles = [{
    id: "opening-title",
    text: "Opening",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "6", timescale: "1" },
    lane: 1,
  }];
  value.resources[0]!.metadata!.streams[0] = {
    kind: "video",
    width: 1280,
    height: 720,
    frameRate: { value: "30", timescale: "1" },
  };

  const xml = compileTimelineIrToFcpxml(value, { target }).xml;

  assert.match(xml, /<format id="r1" name="FFVideoFormat720p30" frameDuration="1\/30s" width="1280" height="720" \/>/);
  assert.match(xml, /<sequence format="r1" duration="3021\/100s">/);
  assert.doesNotMatch(xml, /format="format-framekit"/);
  assert.match(xml, /name="First video" offset="0s" start="149\/30s" duration="127\/15s"/);
  assert.match(xml, /name="Second video" offset="127\/15s" start="10s" duration="23\/2s"/);
  assert.match(xml, /name="Third video" offset="599\/30s" start="59\/30s" duration="307\/30s"/);
  assert.match(xml, /name="opening-title" offset="149\/30s" duration="6s" lane="1"/);
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
    assert.match(artifact.xml, /<title ref="effect-basic-title" name="opening-title" offset="0s" duration="3003\/500s" lane="1">\s*<text>FrameKit MVP Test<\/text>/);
    assert.match(artifact.xml, /<md key="com\.framekit\.id" value="opening-title" \/>/);
    assert.equal(artifact.coverage.exact.includes("connected-elements"), true);
    assert.deepEqual(artifact.coverage.degraded, ["video-edit-frame-rounding"]);
    assert.deepEqual(artifact.coverage.unsupported, []);

    await writeFile(path, artifact.xml, "utf8");
    validateWithInstalledFinalCut(path);
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(
      readback.timeline.storyElements.filter(({ kind }) => kind === "title").map(({ text, start, duration, lane }) => ({ text, start, duration, lane })),
      [{ text: "FrameKit MVP Test", start: 0, duration: 6.006, lane: 1 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("encodes an explicitly selected basic title font", async () => {
  const value = timeline();
  value.sequence.occurrences = [{ ...value.sequence.occurrences[0]!, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" } }];
  value.sequence.storyElements = [];
  value.sequence.titles = [{ id: "opening-title", text: "A日 & 'quote'", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, lane: 1 }];
  const titleFont = { family: "Noto Sans CJK JP", style: "Regular", postscriptName: "NotoSansCJKjp-Regular", digest: "a".repeat(64) };
  const artifact = compileTimelineIrToFcpxml(value, { target, basicTitleFont: titleFont });
  assert.match(artifact.xml, /<text><text-style ref="title-style-1">A日 &amp; &apos;quote&apos;<\/text-style><\/text>/);
  assert.match(artifact.xml, /<text-style-def id="title-style-1"><text-style font="Noto Sans CJK JP" fontFace="Regular" \/><\/text-style-def>/);
  assert.match(artifact.xml, /key="com\.framekit\.title-font-sha256" value="a{64}"/);
  assert.match(artifact.xml, /key="com\.framekit\.title-font-postscript" value="NotoSansCJKjp-Regular"/);
  assert.ok(artifact.coverage.degraded.includes("native-title-font-availability-unverified"));
  assert.equal(artifact.digest, compileTimelineIrToFcpxml(value, { target, basicTitleFont: titleFont }).digest);
  const changedFont = compileTimelineIrToFcpxml(value, { target, basicTitleFont: { ...titleFont, digest: "b".repeat(64) } });
  assert.notEqual(artifact.destination.projectUid, changedFont.destination.projectUid);
  assert.notEqual(artifact.destination.sequenceUid, changedFont.destination.sequenceUid);
  assert.notEqual(artifact.destination.projectUid, compileTimelineIrToFcpxml(value, { target }).destination.projectUid);
  assert.notEqual(artifact.destination.projectUid, compileTimelineIrToFcpxml(value, { target, basicTitleFont: { ...titleFont, style: "Bold" } }).destination.projectUid);
  const canonical = structuredClone(value);
  canonical.sequence.titles![0]!.font = titleFont;
  const canonicalArtifact = compileTimelineIrToFcpxml(canonical, { target });
  assert.match(canonicalArtifact.xml, /<text-style-def id="title-style-1"><text-style font="Noto Sans CJK JP" fontFace="Regular" \/><\/text-style-def>/);
  assert.equal(canonicalArtifact.digest, compileTimelineIrToFcpxml(canonical, { target, basicTitleFont: titleFont }).digest);
  assert.throws(() => compileTimelineIrToFcpxml(canonical, { target, basicTitleFont: { ...titleFont, digest: "b".repeat(64) } }), /FCPXML_TITLE_FONT_MISMATCH/);
  const mixed = structuredClone(canonical);
  mixed.sequence.titles!.push({ ...mixed.sequence.titles![0]!, id: "unbound", font: undefined, startTime: { value: "2", timescale: "1" } });
  assert.throws(() => compileTimelineIrToFcpxml(mixed, { target }), /FCPXML_TITLE_FONT_UNBOUND/);
  mixed.sequence.titles![1]!.font = { ...titleFont, digest: "b".repeat(64) };
  assert.throws(() => compileTimelineIrToFcpxml(mixed, { target }), /FCPXML_TITLE_FONT_MISMATCH/);
  const escapedFont = compileTimelineIrToFcpxml(value, { target, basicTitleFont: { ...titleFont, family: 'Noto & "Friends"', style: "Maker's" } });
  assert.match(escapedFont.xml, /font="Noto &amp; &quot;Friends&quot;" fontFace="Maker&apos;s"/);
  for (const invalid of [null as unknown as typeof titleFont, { ...titleFont, family: " " }, { ...titleFont, style: "\u0000" }, { ...titleFont, digest: "bad" }]) {
    assert.throws(() => compileTimelineIrToFcpxml(value, { target, basicTitleFont: invalid }), /FCPXML_(TITLE_FONT_INVALID|INVALID)/);
  }
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-explicit-title-"));
  try {
    const path = join(directory, "title.fcpxml");
    await writeFile(path, artifact.xml);
    validateWithInstalledFinalCut(path);
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.equal(readback.timeline.storyElements.find(({ kind }) => kind === "title")?.text, "A日 & 'quote'");
    const multiple = structuredClone(value);
    multiple.sequence.titles!.push({ ...multiple.sequence.titles![0]!, id: "second-title", text: "Second", startTime: { value: "2", timescale: "1" } });
    const multipleArtifact = compileTimelineIrToFcpxml(multiple, { target, basicTitleFont: titleFont });
    assert.match(multipleArtifact.xml, /<text-style-def id="title-style-1">/);
    assert.match(multipleArtifact.xml, /<text-style-def id="title-style-2">/);
    await writeFile(path, multipleArtifact.xml);
    validateWithInstalledFinalCut(path);
    const multipleReadback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(multipleReadback.timeline.storyElements.filter(({ kind }) => kind === "title").map(({ text }) => text), ["A日 & 'quote'", "Second"]);
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

  assert.match(artifact.xml, /<asset-clip [^>]*name="Opening"[^>]*start="1001\/200s"[^>]*>[\s\S]*?<title [^>]*name="trimmed-opening-title"[^>]*offset="1001\/200s"/);

  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-trimmed-title-"));
  const path = join(directory, "trimmed-title.fcpxml");
  try {
    await writeFile(path, artifact.xml, "utf8");
    validateWithInstalledFinalCut(path);
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.deepEqual(
      readback.timeline.storyElements.filter(({ kind }) => kind === "title").map(({ start, duration }) => ({ start, duration })),
      [{ start: 0, duration: 6.006 }],
    );
    const exact = structuredClone(value);
    exact.sequence.frameDuration = { value: "1", timescale: "30" };
    exact.sequence.titles![0]!.text = `A日 & <title> "quoted" 'apostrophe' 100%`;
    exact.sequence.titles![0]!.startTime = { value: "1", timescale: "3" };
    exact.sequence.titles![0]!.durationTime = { value: "1", timescale: "3" };
    const exactPath = join(directory, "escaping.fcpxml");
    const exactXml = compileTimelineIrToFcpxml(exact, { target }).xml;
    assert.match(exactXml, /<text>A日 &amp; &lt;title&gt;/);
    await writeFile(exactPath, exactXml, "utf8");
    validateWithInstalledFinalCut(exactPath);
    const exactReadback = await new FcpxmlDocumentAdapter(exactPath).readProject();
    const exactTitle = exactReadback.timeline.storyElements.find(({ id }) => id === "trimmed-opening-title");
    assert.ok(exactTitle);
    assert.equal(exactTitle.text, exact.sequence.titles![0]!.text);
    assert.deepEqual(exactTitle.startTime, { value: "1", timescale: "3" });
    assert.deepEqual(exactTitle.durationTime, { value: "1", timescale: "3" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves embedded video audio and a separate music asset in FCPXML", async () => {
  const value = timeline();
  value.sequence.durationTime = { value: "30", timescale: "1" };
  value.sequence.occurrences = [{
    ...value.sequence.occurrences[0]!,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    sourceStartTime: { value: "5", timescale: "1" },
  }, {
    id: "music-bed",
    name: "Music bed",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "30", timescale: "1" },
    sourceStartTime: { value: "0", timescale: "1" },
    track: 1,
    role: "music",
    mediaId: "music-1",
    gainDb: -12,
  }];
  value.sequence.storyElements = [];
  value.resources[0]!.metadata = {
    durationTime: { value: "20", timescale: "1" },
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
      durationTime: { value: "30", timescale: "1" },
      streams: [{ kind: "audio", sampleRate: 48_000, channels: 1 }],
    },
  });

  const artifact = compileTimelineIrToFcpxml(value, { target });

  assert.match(artifact.xml, /<format id="format-audio" name="FFFrameRateUndefined"/);
  assert.match(artifact.xml, /<asset[^>]*name="opening\.mov"[^>]*hasVideo="1"[^>]*hasAudio="1"[^>]*><media-rep kind="original-media" src="file:\/\/\/media\/opening\.mov" \/><\/asset>/);
  assert.match(artifact.xml, /<asset[^>]*name="licensed-music\.wav"[^>]*hasVideo="0" format="format-audio" hasAudio="1"[^>]*><media-rep kind="original-media" src="file:\/\/\/media\/licensed-music\.wav" \/><\/asset>/);
  assert.match(artifact.xml, /<asset-clip [^>]+audioRole="music">/);
  assert.match(artifact.xml, /<asset-clip [^>]*name="Opening"[^>]*>[\s\S]*?<asset-clip [^>]*offset="1001\/200s"[^>]*duration="30s"[^>]*lane="1"[^>]*audioRole="music">/);
  assert.doesNotMatch(artifact.xml, /<spine>\s*<asset-clip [^>]*audioRole="music"/);
  assert.doesNotMatch(artifact.xml, /<asset-clip [^>]+\srole="music"/);
  assert.match(artifact.xml, /<adjust-volume amount="-12dB" \/>/);

  const directory = await mkdtemp(join(os.tmpdir(), "framekit-fcpxml-music-role-"));
  const path = join(directory, "music-role.fcpxml");
  try {
    await writeFile(path, artifact.xml, "utf8");
    validateWithInstalledFinalCut(path);
    const readback = await new FcpxmlDocumentAdapter(path).readProject();
    assert.equal(readback.timeline.clips.find(({ id }) => id === "music-bed")?.role, "music");
    assert.deepEqual(
      readback.timeline.clips.find(({ id }) => id === "music-bed") && {
        start: readback.timeline.clips.find(({ id }) => id === "music-bed")?.start,
        duration: readback.timeline.clips.find(({ id }) => id === "music-bed")?.duration,
      },
      { start: 0, duration: 30 },
    );
    const reused = structuredClone(value);
    reused.sequence.frameDuration = { value: "1", timescale: "30" };
    const first = reused.sequence.occurrences.find(({ id }) => id === "music-bed")!;
    first.startTime = { value: "1", timescale: "3" };
    first.sourceStartTime = { value: "1", timescale: "3" };
    first.durationTime = { value: "1", timescale: "3" };
    first.gainDb = -6;
    reused.sequence.occurrences.push({ ...structuredClone(first), id: "music-repeat", name: "Music repeat", startTime: { value: "4", timescale: "3" }, sourceStartTime: { value: "4", timescale: "3" }, gainDb: -12 });
    const reusedPath = join(directory, "music-reused.fcpxml");
    await writeFile(reusedPath, compileTimelineIrToFcpxml(reused, { target }).xml, "utf8");
    validateWithInstalledFinalCut(reusedPath);
    const reusedReadback = await new FcpxmlDocumentAdapter(reusedPath).readProject();
    const firstClip = reusedReadback.timeline.clips.find(({ id }) => id === "music-bed")!;
    const secondClip = reusedReadback.timeline.clips.find(({ id }) => id === "music-repeat")!;
    assert.ok(firstClip && secondClip);
    assert.equal(firstClip.mediaId, secondClip.mediaId);
    assert.deepEqual([firstClip.startTime, firstClip.durationTime, firstClip.sourceStartTime, firstClip.gainDb], [{ value: "1", timescale: "3" }, { value: "1", timescale: "3" }, { value: "1", timescale: "3" }, -6]);
    assert.deepEqual([secondClip.startTime, secondClip.durationTime, secondClip.sourceStartTime, secondClip.gainDb], [{ value: "4", timescale: "3" }, { value: "1", timescale: "3" }, { value: "4", timescale: "3" }, -12]);
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
  const parentStart = xml.indexOf('name="Opening"');
  const childStart = xml.indexOf('name="Connected"');
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
    /FCPXML_DISSOLVE_FRAME_ALIGNMENT/,
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
  assert.match(artifact.xml, /<sequence format="r1"/);
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
    assert.deepEqual(snapshot.timeline.clips[0]?.sourceStartTime, { value: "1001", timescale: "24000" });
    assert.equal(snapshot.timeline.clips[0]?.mediaId, "resource-media-1");
    assert.equal(snapshot.timeline.clips[0]?.gainDb, -3);
    assert.equal(snapshot.timeline.markers[0]?.name, "Review & approve");
    assert.equal(snapshot.timeline.markers[0]?.id, "review-42");
    assert.equal(snapshot.timeline.captions[0]?.text, "Hello <world>");
    assert.equal(snapshot.timeline.captions[0]?.id, "subtitle-abc");
    assert.equal(snapshot.timeline.storyElements.some(({ id }) => id === "gap-1"), true);
    assert.equal((await readFile(path, "utf8")).includes("<fcpxml version=\"1.11\">"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML compilation refuses to discard an explicit nonzero timecode origin", () => {
  const value = timeline();
  value.sequence.timecodeStart = { value: "3600", timescale: "1" };
  assert.throws(() => compileTimelineIrToFcpxml(value, { target }), /FCPXML_UNSUPPORTED.*timecode.*origin/i);
  value.sequence.timecodeStart = { value: "0", timescale: "24000" };
  assert.match(compileTimelineIrToFcpxml(value, { target }).xml, /tcStart="0s"/);
});

test("FCPXML compilation refuses to discard a nonzero frame-grid origin", () => {
  const value = timeline();
  value.sequence.frameGridOrigin = { value: "1", timescale: "48" };
  assert.throws(() => compileTimelineIrToFcpxml(value, { target }), /FCPXML_UNSUPPORTED.*frame.grid.*origin/i);
});
