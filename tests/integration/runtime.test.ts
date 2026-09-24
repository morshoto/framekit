import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { AgentVideoRuntime, diffSnapshots, type ProjectSnapshot } from "@framekit/runtime";

function createRuntime() {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Phase 0 Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-1", name: "Interview", start: 0, duration: 10, track: 1 },
    ],
  }));
}

test("Phase 0 proves read, write, read-after-write, and diff", async () => {
  const runtime = createRuntime();

  const before = await runtime.inspectProject();
  assert.equal(before.timeline.clips[0]?.name, "Interview");

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "clip-1",
    name: "Interview - Clean",
  });

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.before.timeline.clips[0]?.name, "Interview");
  assert.equal(transaction.after.timeline.clips[0]?.name, "Interview - Clean");
  assert.equal(transaction.diff.affectedRanges.length, 1);
  assert.deepEqual(transaction.diff.modified, [
    {
      type: "ITEM_MODIFIED",
      itemId: "clip-1",
      before: {
        id: "clip-1", name: "Interview", start: 0, duration: 10, track: 1,
        startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" },
      },
      after: {
        id: "clip-1", name: "Interview - Clean", start: 0, duration: 10, track: 1,
        startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" },
      },
    },
  ]);
});

test("Phase 0 rejects stale writes", async () => {
  const runtime = createRuntime();
  const base = await runtime.inspectProject();

  await runtime.edit({ type: "rename-clip", clipId: "clip-1", name: "First" });

  await assert.rejects(
    runtime.edit({
      type: "rename-clip",
      clipId: "clip-1",
      name: "Stale",
      baseRevision: base.revision,
    }),
    /STALE_CONTEXT/,
  );
});

test("diff compares timeline duration and metadata changes exhaustively", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Diff fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [{ id: "clip-1", name: "Clip", start: 0, duration: 10, track: 1 }],
    markers: [{ id: "marker-1", start: 2, duration: 1, name: "Before" }],
  });
  const before = await adapter.readProject();
  const after = structuredClone(before);
  after.timeline.duration = 20;
  after.timeline.markers[0] = { ...after.timeline.markers[0]!, name: "After" };
  after.timeline.captions = [{ id: "caption-1", start: 4, duration: 2, text: "Hello" }];
  after.revision = { id: "rev-1", sequence: 1, timestamp: new Date(1).toISOString() };
  const diff = diffSnapshots(before, after);
  assert.equal(diff.durationDelta, 10);
  assert.equal(diff.markerChanges[0]?.type, "MARKER_MODIFIED");
  assert.equal(diff.captionChanges[0]?.type, "CAPTION_ADDED");
  assert.ok(diff.affectedRanges.some((range) => range.start === 4 && range.end === 6));
});

test("media registry diff ignores attached analysis but detects registry field changes", () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Media diff fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{
      mediaId: "media-1",
      source: "clip.mov",
      mediaKind: "video",
      duration: 10,
      sourceDigest: "sha256:before",
    }],
  });
  return adapter.readProject().then((before) => {
    const enriched = structuredClone(before);
    enriched.media[0]!.visual = { scenes: [], subjects: [], keyframes: [] };
    enriched.media[0]!.analysisRevision = before.revision.id;
    assert.deepEqual(diffSnapshots(before, enriched).mediaChanges, []);

    const changed = structuredClone(enriched);
    changed.media[0]!.sourceDigest = "sha256:after";
    assert.equal(diffSnapshots(before, changed).mediaChanges[0]?.type, "MEDIA_MODIFIED");
  });
});

test("timeline diffs preserve target provenance and complete entity values", () => {
  const before: ProjectSnapshot = {
    projectId: "project-1",
    projectName: "Provenance fixture",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 12,
      durationTime: { value: "12", timescale: "1" },
      clips: [
        {
          id: "clip-b",
          name: "Connected",
          start: 6,
          duration: 6,
          track: 2,
          attachedTo: "clip-a",
          role: "audio",
          gainDb: -6,
          startTime: { value: "6", timescale: "1" },
          durationTime: { value: "6", timescale: "1" },
        },
        {
          id: "clip-a",
          name: "Primary",
          start: 0,
          duration: 6,
          track: 1,
          role: "video",
          gainDb: 0,
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "6", timescale: "1" },
        },
      ],
      storyElements: [{
        id: "story-1",
        kind: "title",
        start: 1,
        duration: 2,
        startTime: { value: "1", timescale: "1" },
        durationTime: { value: "2", timescale: "1" },
      }],
      markers: [{ id: "marker-1", start: 2, duration: 1, name: "Before" }],
      captions: [{ id: "caption-1", start: 3, duration: 1, text: "Before" }],
    },
    media: [{ mediaId: "media-1", source: "clip.mov", mediaKind: "video", duration: 6 }],
    revision: { id: "rev-before", sequence: 1, timestamp: "2026-09-25T00:00:00.000Z" },
  };
  const after = structuredClone(before);
  after.timeline.clips = [
    { ...after.timeline.clips[1]!, role: "audio", gainDb: -3 },
    after.timeline.clips[0]!,
  ];
  after.timeline.storyElements[0] = { ...after.timeline.storyElements[0]!, text: "After" };
  after.timeline.markers[0] = { ...after.timeline.markers[0]!, name: "After" };
  after.timeline.captions[0] = { ...after.timeline.captions[0]!, text: "After" };
  after.media[0] = { ...after.media[0]!, sourceDigest: "sha256:after" };
  after.revision = { id: "rev-after", sequence: 2, timestamp: "2026-09-25T00:00:01.000Z" };

  const diff = diffSnapshots(before, after);

  assert.deepEqual(diff.provenance, {
    source: "project-snapshot",
    projectId: "project-1",
    sequenceId: "timeline-1",
    fromRevision: before.revision,
    toRevision: after.revision,
  });
  assert.deepEqual(diff.modified.map((change) => change.itemId), ["clip-a"]);
  assert.equal(diff.modified[0]?.before?.role, "video");
  assert.equal(diff.modified[0]?.after?.role, "audio");
  assert.equal(diff.modified[0]?.before?.gainDb, 0);
  assert.equal(diff.modified[0]?.after?.gainDb, -3);
  assert.deepEqual(diff.markerChanges[0], {
    type: "MARKER_MODIFIED",
    itemId: "marker-1",
    marker: after.timeline.markers[0],
    before: before.timeline.markers[0],
    after: after.timeline.markers[0],
  });
  assert.equal(diff.captionChanges[0]?.itemId, "caption-1");
  assert.equal(diff.captionChanges[0]?.before?.text, "Before");
  assert.equal(diff.captionChanges[0]?.after?.text, "After");
  assert.equal(diff.storyElementChanges[0]?.itemId, "story-1");
  assert.equal(diff.storyElementChanges[0]?.before?.text, undefined);
  assert.equal(diff.storyElementChanges[0]?.after?.text, "After");
  assert.equal(diff.mediaChanges[0]?.itemId, "media-1");
  assert.equal(diff.mediaChanges[0]?.before?.sourceDigest, undefined);
  assert.equal(diff.mediaChanges[0]?.after?.sourceDigest, "sha256:after");
});

test("timeline diffs preserve exact duration and playhead changes", () => {
  const before: ProjectSnapshot = {
    projectId: "project-1",
    projectName: "Rational fixture",
    playheadTime: { value: "1", timescale: "24" },
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 1 / 3,
      durationTime: { value: "1", timescale: "3" },
      clips: [{
        id: "clip-1",
        name: "Clip",
        start: 0,
        duration: 1 / 3,
        track: 1,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "1", timescale: "3" },
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    media: [],
    revision: { id: "rev-before", sequence: 1, timestamp: "2026-09-25T00:00:00.000Z" },
  };
  const after = structuredClone(before);
  after.timeline.duration = 2 / 3;
  after.timeline.durationTime = { value: "2", timescale: "3" };
  after.playheadTime = { value: "5", timescale: "24" };
  after.revision = { id: "rev-after", sequence: 2, timestamp: "2026-09-25T00:00:01.000Z" };

  const diff = diffSnapshots(before, after);

  assert.equal(diff.durationDelta, 1 / 3);
  assert.deepEqual(diff.durationDeltaTime, { value: "1", timescale: "3" });
  assert.deepEqual(diff.playheadChange, {
    before: { value: "1", timescale: "24" },
    after: { value: "5", timescale: "24" },
  });
  assert.equal(diffSnapshots(before, structuredClone(before)).playheadChange, undefined);
});

test("timeline diffs omit equivalent state and reject ambiguous targets", () => {
  const before: ProjectSnapshot = {
    projectId: "project-1",
    projectName: "Identity fixture",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 2,
      clips: [{
        id: "clip-1",
        name: "Clip",
        start: 0,
        duration: 2,
        track: 1,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "2", timescale: "1" },
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    media: [],
    revision: { id: "rev-before", sequence: 1, timestamp: "2026-09-25T00:00:00.000Z" },
  };
  const equivalent = structuredClone(before);
  equivalent.timeline.clips[0] = { ...equivalent.timeline.clips[0]!, gainDb: undefined };
  equivalent.revision = { id: "rev-equivalent", sequence: 2, timestamp: "2026-09-25T00:00:01.000Z" };

  const diff = diffSnapshots(before, equivalent);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.modified, []);

  const duplicate = structuredClone(before);
  duplicate.timeline.clips.push(structuredClone(duplicate.timeline.clips[0]!));
  assert.throws(() => diffSnapshots(before, duplicate), /AMBIGUOUS_TIMELINE_IDENTITY/);

  const differentTarget = structuredClone(before);
  differentTarget.timeline.id = "timeline-2";
  assert.throws(() => diffSnapshots(before, differentTarget), /TARGET_MISMATCH/);
});
