import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("FCPXML operation coverage has a documented evidence boundary", async () => {
  const matrix = await readFile("docs/final-cut/fcpxml-operation-matrix.md", "utf8");

  for (const operation of [
    "timeline.media.add",
    "timeline.media.move",
    "timeline.media.replace",
    "timeline.media.remove",
    "timeline.audio.fades",
    "timeline.audio.attach",
    "timeline.audio.mix",
    "timeline.title.add",
    "timeline.transition.add",
    "ripple-delete",
    "timeline.mask.add",
  ]) {
    assert.match(matrix, new RegExp(operation.replaceAll(".", "\\.")));
  }
  assert.match(matrix, /CAPABILITY_UNAVAILABLE/);
  assert.match(matrix, /does not prove a live\s+Final Cut timeline change/i);
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
