import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowOperation } from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";

const documentWithOperations = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <format id="format-main" frameDuration="1/24s" />
    <asset id="video-a" name="A.mov" src="file:///fixtures/a.mov" hasVideo="1" hasAudio="1" duration="12s" />
    <asset id="video-b" name="B.mov" src="file:///fixtures/b.mov" hasVideo="1" duration="8s" />
    <asset id="audio-a" name="Voice.wav" src="file:///fixtures/voice.wav" hasVideo="0" hasAudio="1" duration="6s" />
    <effect id="title-effect" name="Basic Title" uid="/Titles/Basic.localized/Basic.moti" />
    <effect id="transition-effect" name="Cross Dissolve" uid="/Transitions/Cross.localized/Cross.moti" />
  </resources>
  <library>
    <event name="Event">
      <project uid="project-260" name="Issue 260">
        <sequence uid="sequence-260" format="format-main" duration="8s">
          <spine>
            <asset-clip id="clip-a" ref="video-a" offset="0s" start="1s" duration="4s" />
            <asset-clip id="clip-b" ref="video-a" offset="4s" start="5s" duration="4s" />
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

async function artifact(contents = documentWithOperations): Promise<{ path: string; adapter: FcpxmlDocumentAdapter }> {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-operation-parity-"));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, contents);
  return { path, adapter: new FcpxmlDocumentAdapter(path) };
}

test("FCPXML capabilities advertise only the documented safe operation matrix", async () => {
  const { adapter } = await artifact();
  const capabilities = await adapter.getCapabilities();
  const assets = await adapter.listAssets();

  assert.equal(capabilities.editor.timelineWrite, false);
  assert.equal(capabilities.editor.timelineArtifactWrite, true);
  assert.equal(capabilities.editor.mediaPlacement, true);
  assert.equal(capabilities.editor.clipMove, true);
  assert.equal(capabilities.editor.clipReplace, true);
  assert.equal(capabilities.editor.clipRemoval, true);
  assert.equal(capabilities.editor.titlePlacement, true);
  assert.equal(capabilities.editor.transitionPlacement, true);
  assert.equal(capabilities.editor.audioAttachment, true);
  assert.equal(capabilities.editor.audioMixing, true);
  assert.equal(capabilities.editor.masking, false);
  assert.equal(capabilities.families?.canonicalDocument.write.available, false);
  assert.equal(capabilities.families?.canonicalDocument.artifactWrite.available, true);
  assert.equal(assets.find((asset) => asset.metadata.localId === "title-effect")?.metadata.identity,
    "/Titles/Basic.localized/Basic.moti");
  assert.equal(assets.find((asset) => asset.metadata.localId === "transition-effect")?.metadata.identity,
    "/Transitions/Cross.localized/Cross.moti");
});

test("FCPXML media operations preview, execute, verify, diff, and undo", async () => {
  const { path, adapter } = await artifact();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const operations: WorkflowOperation[] = [
    {
      type: "timeline.media.add",
      occurrenceId: "clip-c",
      mediaId: "video-b",
      role: "video",
      start: 8,
      duration: 2,
      targetLane: "primary",
    },
    { type: "timeline.media.move", occurrenceId: "clip-b", start: 5, targetLane: "primary" },
    { type: "timeline.media.replace", occurrenceId: "clip-a", mediaId: "video-b", duration: 3 },
    { type: "timeline.media.remove", occurrenceId: "clip-b" },
  ];

  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations });
  assert.deepEqual(await runtime.inspectProject(), before);
  const transaction = await runtime.executeEdit(preview.previewToken);
  const after = transaction.after;

  assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
  assert.equal(transaction.diff.modified.some((change) => change.itemId === "clip-a"), true);
  assert.equal(after.timeline.clips.find((clip) => clip.id === "clip-a")?.mediaId, "video-b");
  assert.equal(after.timeline.clips.find((clip) => clip.id === "clip-a")?.duration, 3);
  assert.equal(after.timeline.clips.find((clip) => clip.id === "clip-c")?.start, 8);
  assert.equal(after.timeline.clips.some((clip) => clip.id === "clip-b"), false);
  const xml = await readFile(path, "utf8");
  assert.match(xml, /ref="video-b"/);
  assert.match(xml, /id="clip-c"/);

  const undone = await runtime.undo(transaction.id);
  assert.deepEqual(undone.timeline.clips, before.timeline.clips);
});

test("FCPXML media additions preserve music roles through read-after-write", async () => {
  const { path, adapter } = await artifact();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{
      type: "timeline.media.add",
      occurrenceId: "music-1",
      mediaId: "audio-a",
      role: "music",
      start: 8,
      duration: 2,
      targetLane: 1,
    }],
  });

  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
  assert.equal(transaction.after.timeline.clips.find((clip) => clip.id === "music-1")?.role, "music");
  assert.match(await readFile(path, "utf8"), /id="music-1"[^>]+role="music"/);
});

test("FCPXML marker edits stay inside a DTD-valid story element", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-marker-dtd-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><resources><format id="format-main" frameDuration="1/24s" /></resources>
  <library><event name="Event"><project uid="project-marker" name="Marker Project">
    <sequence format="format-main" duration="1s"><spine>
      <gap name="Black" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "add-marker",
        timelineId: before.timeline.id,
        marker: { id: "marker-1", start: 0, duration: 0, name: "Framekit Publisher E2E" },
      }],
    });

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
    assert.equal(transaction.after.timeline.markers[0]?.id, "marker-1");
    assert.equal(transaction.after.timeline.markers[0]?.name, "Framekit Publisher E2E");
    assert.equal(transaction.after.timeline.markers[0]?.start, 0);

    const xml = await readFile(path, "utf8");
    assert.match(xml, /<gap[^>]*>\s*<marker(?=[^>]*\bstart="0\/1s")(?=[^>]*\bduration="0\/1s")(?=[^>]*\bvalue="Framekit Publisher E2E")(?=[^>]*\bnote="com\.framekit\.id:marker-1")[^>]*><\/marker>\s*<\/gap>/);
    assert.doesNotMatch(xml, /<spine[^>]*>\s*<marker/);
    assert.doesNotMatch(xml, /<marker[^>]*\bid=/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML markers inside auditions attach to an audition story element", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-audition-marker-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><resources>
  <format id="format-audition" frameDuration="1/24s" />
  <asset id="source" name="Source.mov" src="file:///fixtures/source.mov" hasVideo="1" duration="2s" />
</resources><library><event name="Event"><project uid="project-audition" name="Audition Project">
  <sequence format="format-audition" duration="2s"><spine>
    <audition offset="0s" duration="2s"><asset-clip ref="source" offset="0s" start="0s" duration="2s" /></audition>
  </spine></sequence>
</project></event></library></fcpxml>`);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "add-marker",
        timelineId: before.timeline.id,
        marker: { id: "audition-marker", start: 1, duration: 0, name: "Audition Marker" },
      }],
    });

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
    const xml = await readFile(path, "utf8");
    assert.match(xml, /<audition[^>]*>\s*<asset-clip[^>]*>\s*<marker[^>]*value="Audition Marker"/);
    assert.doesNotMatch(xml, /<audition[^>]*>\s*<marker/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML gap markers round-trip from nonzero source time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-gap-marker-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><library><event name="Event"><project uid="project-gap-marker" name="Gap Marker Project">
  <sequence duration="2s"><spine><gap name="Black" offset="0s" start="5s" duration="2s" /></spine></sequence>
</project></event></library></fcpxml>`);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "add-marker",
        timelineId: before.timeline.id,
        marker: { id: "gap-marker", start: 1, duration: 0, name: "Gap Marker" },
      }],
    });

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
    assert.equal(transaction.after.timeline.markers[0]?.start, 1);
    const xml = await readFile(path, "utf8");
    assert.match(xml, /<gap[^>]*start="5s"[^>]*>\s*<marker[^>]*start="6\/1s"[^>]*value="Gap Marker"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML audio markers round-trip from nonzero source time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-audio-marker-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><resources>
  <format id="format-audio-marker" frameDuration="1/24s" />
  <asset id="video-source" name="Video.mov" duration="2s" hasVideo="1"><media-rep src="file:///fixtures/video.mov" /></asset>
  <asset id="audio-source" name="Audio.wav" duration="8s" hasAudio="1"><media-rep src="file:///fixtures/audio.wav" /></asset>
</resources><library><event name="Event"><project uid="project-audio-marker" name="Audio Marker Project">
  <sequence format="format-audio-marker" duration="2s"><spine>
    <asset-clip ref="video-source" offset="0s" start="0s" duration="1/2s">
      <audio ref="audio-source" lane="1" offset="0s" start="5s" duration="2s" />
    </asset-clip>
  </spine></sequence>
</project></event></library></fcpxml>`);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "add-marker",
        timelineId: before.timeline.id,
        marker: { id: "audio-marker", start: 1, duration: 0, name: "Audio Marker" },
      }],
    });

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
    assert.equal(transaction.after.timeline.markers[0]?.start, 1);
    const xml = await readFile(path, "utf8");
    assert.match(xml, /<audio[^>]*start="5s"[^>]*>\s*<marker[^>]*start="6\/1s"[^>]*value="Audio Marker"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML markers precede ordered filter and metadata children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-fcpxml-filter-marker-"));
  try {
    const path = join(directory, "project.fcpxml");
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11"><resources>
  <format id="format-filter" frameDuration="1/24s" />
  <asset id="source" name="Source.mov" duration="2s" hasVideo="1"><media-rep src="file:///fixtures/source.mov" /></asset>
  <effect id="filter-effect" name="Test Filter" uid="/Effects/Test.localized/Test.moti" />
</resources><library><event name="Event"><project uid="project-filter-marker" name="Filter Marker Project">
  <sequence format="format-filter" duration="2s"><spine>
    <asset-clip ref="source" offset="0s" start="0s" duration="2s"><filter-video ref="filter-effect" /><metadata /></asset-clip>
  </spine></sequence>
</project></event></library></fcpxml>`);
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "add-marker",
        timelineId: before.timeline.id,
        marker: { id: "filtered-marker", start: 1, duration: 0, name: "Filtered Marker" },
      }],
    });

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
    const xml = await readFile(path, "utf8");
    const assetClip = xml.match(/<asset-clip[^>]*>([\s\S]*?)<\/asset-clip>/)?.[1];
    assert.ok(assetClip);
    const markerIndex = assetClip.indexOf("<marker");
    const filterIndex = assetClip.indexOf("<filter-video");
    const metadataIndex = assetClip.indexOf("<metadata");
    assert.ok(markerIndex >= 0 && markerIndex < filterIndex && filterIndex < metadataIndex, assetClip);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FCPXML titles, transitions, and audio parameters round-trip through one transaction", async () => {
  const { path, adapter } = await artifact();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const assets = await adapter.listAssets();
  const title = assets.find((asset) => asset.metadata.localId === "title-effect");
  const transition = assets.find((asset) => asset.metadata.localId === "transition-effect");
  assert.ok(title);
  assert.ok(transition);

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [
      {
        type: "timeline.title.add",
        occurrenceId: "title-1",
        assetId: title.id,
        text: "Framekit",
        start: 1,
        duration: 2,
        targetLane: 2,
      },
      {
        type: "timeline.transition.add",
        transitionId: "transition-1",
        assetId: transition.id,
        beforeClipId: "clip-a",
        afterClipId: "clip-b",
        duration: 1,
      },
      { type: "timeline.audio.fades", clipId: "clip-a", fadeIn: 0.5, fadeOut: 0.75 },
      {
        type: "timeline.audio.attach",
        occurrenceId: "voice-1",
        targetClipId: "clip-a",
        mediaId: "audio-a",
        startOffset: 0.25,
        duration: 2,
      },
      { type: "timeline.audio.mix", clipId: "voice-1", gainDb: -12, fadeIn: 0.25, fadeOut: 0.25 },
    ],
  });
  assert.deepEqual(await runtime.inspectProject(), before);

  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "VERIFIED", JSON.stringify(transaction.verification));
  const after = transaction.after;
  assert.equal(after.timeline.clips.find((clip) => clip.id === "voice-1")?.attachedTo, "clip-a");
  assert.equal(after.timeline.clips.find((clip) => clip.id === "voice-1")?.gainDb, -12);
  assert.equal(after.timeline.clips.find((clip) => clip.id === "voice-1")?.fadeIn, 0.25);
  assert.equal(after.timeline.clips.find((clip) => clip.id === "clip-a")?.fadeOut, 0.75);
  assert.deepEqual(after.timeline.storyElements.find((element) => element.id === "title-1"), {
    id: "title-1",
    kind: "title",
    start: 1,
    duration: 2,
    startTime: { value: "1", timescale: "1" },
    durationTime: { value: "2", timescale: "1" },
    lane: 2,
    assetId: title.id,
    text: "Framekit",
  });
  assert.equal(after.timeline.storyElements.find((element) => element.id === "transition-1")?.assetId, transition.id);

  const xml = await readFile(path, "utf8");
  assert.match(xml, /<title[^>]+ref="title-effect"/);
  assert.match(xml, /<text>Framekit<\/text>/);
  assert.match(xml, /<filter-video[^>]+ref="transition-effect"/);
  assert.match(xml, /<fadeIn[^>]+duration="1\/2s"/);
  assert.match(xml, /<fadeOut[^>]+duration="3\/4s"/);
});

test("FCPXML ripple delete preserves source ranges and rational timing", async () => {
  const { path, adapter } = await artifact(`<?xml version="1.0"?>
<fcpxml version="1.11"><resources>
  <format id="format-main" frameDuration="1001/24000s" />
  <asset id="video-a" src="file:///fixtures/a.mov" hasVideo="1" duration="12s" />
  <asset id="video-b" src="file:///fixtures/b.mov" hasVideo="1" duration="8s" />
</resources><library><event><project uid="project-ripple" name="Ripple">
  <sequence uid="sequence-ripple" format="format-main" duration="8s"><spine>
    <asset-clip id="clip-a" ref="video-a" offset="0s" start="3s" duration="4s" />
    <gap id="gap-1" offset="4s" duration="1s" />
    <asset-clip id="clip-b" ref="video-b" offset="5s" start="7s" duration="3s" />
  </spine></sequence>
</project></event></library></fcpxml>`);
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{ type: "ripple-delete", timelineId: before.timeline.id, range: { start: 2, end: 4 } }],
  });
  assert.deepEqual(await runtime.inspectProject(), before);
  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    transaction.after.timeline.clips.map(({ id, start, duration, sourceStart, startTime, durationTime }) => ({
      id, start, duration, sourceStart, startTime, durationTime,
    })),
    [
      { id: "clip-a", start: 0, duration: 2, sourceStart: 3, startTime: { value: "0", timescale: "1" }, durationTime: { value: "2", timescale: "1" } },
      { id: "clip-b", start: 3, duration: 3, sourceStart: 7, startTime: { value: "3", timescale: "1" }, durationTime: { value: "3", timescale: "1" } },
    ],
  );
  assert.equal(transaction.after.timeline.duration, 6);
  assert.match(await readFile(path, "utf8"), /offset="3\/1s"/);
});

test("FCPXML ripple delete rejects ranges outside sequence bounds before preview", async () => {
  const { path, adapter } = await artifact();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const original = await readFile(path, "utf8");

  for (const range of [{ start: -1, end: 1 }, { start: 7, end: 9 }]) {
    await assert.rejects(runtime.previewEdit({
      baseRevision: before.revision,
      operations: [{ type: "ripple-delete", timelineId: before.timeline.id, range }],
    }), new RegExp(`ripple-delete range \\[${range.start}, ${range.end}\\) must fit timeline bounds \\[0, 8\\)`));
    assert.deepEqual(await runtime.inspectProject(), before);
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("FCPXML preview and transaction failures leave bytes unchanged", async () => {
  const { path, adapter } = await artifact();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const original = await readFile(path, "utf8");

  await assert.rejects(runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{ type: "timeline.mask.add", occurrenceId: "clip-a", mask: { mode: "rectangle", bounds: { x: 0, y: 0, width: 1, height: 1 } } }],
  }), /CAPABILITY_UNAVAILABLE/);
  assert.equal(await readFile(path, "utf8"), original);

  await assert.rejects(runtime.previewEdit({
    baseRevision: before.revision,
    operations: [
      { type: "timeline.media.move", occurrenceId: "clip-a", start: 1 },
      { type: "timeline.picture-in-picture.add", occurrenceId: "pip-1", mediaId: "video-b", attachedTo: "missing", start: 1, duration: 1, targetLane: 1, position: { x: 0, y: 0 }, scale: 1 },
    ],
  }), /CLIP_NOT_FOUND/);
  assert.equal(await readFile(path, "utf8"), original);
});
