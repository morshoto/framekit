import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { AgentVideoRuntime, diffSnapshots } from "@framekit/runtime";

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
