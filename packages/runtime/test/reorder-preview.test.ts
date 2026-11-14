import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSnapshot } from "../src/domain/project.js";
import { assertReorderPreviewCurrent, previewPrimaryStorylineReorder, verifyPrimaryStorylineReorder } from "../src/timeline/reorder-preview.js";

function fixture(): ProjectSnapshot {
  const frame = (n: number) => ({ value: String(n * 1001), timescale: "24000" });
  const clip = (id: string, mediaId: string, start: number, duration: number, source: number) => ({
    id, mediaId, name: id, start: start * 1001 / 24000, duration: duration * 1001 / 24000,
    startTime: frame(start), durationTime: frame(duration), sourceStartTime: frame(source), track: 0, role: "video" as const,
  });
  const clips = [clip("a", "one", 100, 2, 3), clip("b", "two", 102, 4, 5), clip("c", "one", 106, 6, 9)];
  return {
    projectId: "project", projectName: "Example", revision: { id: "rev-1", sequence: 1, timestamp: "2026-01-01T00:00:00Z" },
    timeline: { id: "sequence", name: "Example", duration: 12 * 1001 / 24000, durationTime: frame(12), frameDuration: frame(1),
      clips, storyElements: clips.map((item) => ({ id: item.id, kind: "asset-clip", mediaId: item.mediaId, start: item.start, duration: item.duration, startTime: item.startTime, durationTime: item.durationTime })), markers: [], captions: [] },
    media: [{ mediaId: "one", source: "/media/one.mov" }, { mediaId: "two", source: "/media/two.mov" }],
  };
}

test("reorder preview preserves source ranges and reports exact affected order", () => {
  const before = fixture();
  const original = structuredClone(before);
  const preview = previewPrimaryStorylineReorder(before, "c", { kind: "before", occurrenceId: "a" });
  assert.equal(preview.noOp, false);
  assert.deepEqual(preview.before.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(preview.after.map(({ id }) => id), ["c", "a", "b"]);
  assert.deepEqual(preview.after.map(({ startTime }) => startTime), [
    { value: "100100", timescale: "24000" }, { value: "53053", timescale: "12000" }, { value: "9009", timescale: "2000" },
  ]);
  assert.deepEqual(preview.after.map(({ sourceStartTime }) => sourceStartTime), [before.timeline.clips[2]!.sourceStartTime, before.timeline.clips[0]!.sourceStartTime, before.timeline.clips[1]!.sourceStartTime]);
  assert.deepEqual(before, original);
});

test("self and unchanged destination are explicit no-ops", () => {
  const before = fixture();
  for (const destination of [{ kind: "before" as const, occurrenceId: "b" }, { kind: "after" as const, occurrenceId: "a" }]) {
    const preview = previewPrimaryStorylineReorder(before, "b", destination);
    assert.equal(preview.noOp, true);
    assert.deepEqual(preview.before, []);
    assert.deepEqual(preview.after, []);
  }
});

test("no-op preview identifies the exact source and range", () => {
  const preview = previewPrimaryStorylineReorder(fixture(), "b", { kind: "after", occurrenceId: "a" });
  assert.equal(preview.noOp, true);
  assert.equal(preview.moving.id, "b");
  assert.equal(preview.source, "/media/two.mov");
  assert.deepEqual(preview.moving.sourceStartTime, { value: "5005", timescale: "24000" });
  assert.deepEqual(preview.moving.durationTime, { value: "4004", timescale: "24000" });
});

test("moving later preserves the full affected order and source bindings", () => {
  const input = fixture();
  const preview = previewPrimaryStorylineReorder(input, "a", { kind: "end" });
  assert.deepEqual(preview.before.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(preview.after.map(({ id }) => id), ["b", "c", "a"]);
  assert.deepEqual(preview.after.map(({ mediaId }) => mediaId), ["two", "one", "one"]);
  assert.deepEqual(preview.after.map(({ startTime }) => startTime), [
    { value: "100100", timescale: "24000" }, { value: "13013", timescale: "3000" }, { value: "11011", timescale: "2400" },
  ]);
  assert.deepEqual(preview.after.map(({ durationTime }) => durationTime), [input.timeline.clips[1]!.durationTime, input.timeline.clips[2]!.durationTime, input.timeline.clips[0]!.durationTime]);
});

test("reorder preview rejects unsupported destination values", () => {
  assert.throws(() => previewPrimaryStorylineReorder(fixture(), "b", { kind: "unknown", occurrenceId: "a" } as never), /REORDER_INVALID.*destination/);
  assert.throws(() => previewPrimaryStorylineReorder(fixture(), "b", null as never), /REORDER_INVALID.*destination/);
});

test("reorder preview rejects an unaccounted primary story element", () => {
  const input = fixture();
  input.timeline.storyElements.push({ id: "unaccounted", kind: "asset-clip", mediaId: "one", start: 5, duration: 1, startTime: { value: "5", timescale: "1" }, durationTime: { value: "1", timescale: "1" } });
  assert.throws(() => previewPrimaryStorylineReorder(input, "a", { kind: "end" }), /REORDER_(INVALID|UNSUPPORTED).*story/i);
});


test("reorder preview rejects stale target, revision, source and outside-span edits", () => {
  const original = fixture();
  const preview = previewPrimaryStorylineReorder(original, "b", { kind: "before", occurrenceId: "a" });
  assert.doesNotThrow(() => assertReorderPreviewCurrent(preview, structuredClone(original)));
  for (const change of ["project", "revision", "source", "outside"] as const) {
    const current = structuredClone(original);
    if (change === "project") current.projectId = "other";
    if (change === "revision") current.revision.sequence++;
    if (change === "source") current.media[0]!.source = "/other.mov";
    if (change === "outside") current.timeline.clips[2]!.name = "changed";
    assert.throws(() => assertReorderPreviewCurrent(preview, current), /REORDER_PREVIEW_STALE/, change);
  }
  const tampered = structuredClone(preview);
  tampered.after[0]!.startTime.value = "0";
  assert.throws(() => assertReorderPreviewCurrent(tampered, original), /REORDER_PREVIEW_STALE/);
});


test("reorder readback checks every occurrence and outside-span state", () => {
  const before = fixture();
  const preview = previewPrimaryStorylineReorder(before, "b", { kind: "before", occurrenceId: "a" });
  const after = structuredClone(before);
  after.revision = { id: "rev-2", sequence: 2, timestamp: "2026-01-01T00:00:01Z" };
  const [a, b, c] = after.timeline.clips;
  b!.startTime = { value: "100100", timescale: "24000" }; b!.start = 100100 / 24000;
  a!.startTime = { value: "104104", timescale: "24000" }; a!.start = 104104 / 24000;
  after.timeline.clips = [b!, a!, c!];
  const [storyA, storyB, storyC] = after.timeline.storyElements;
  storyB!.startTime = b!.startTime; storyB!.start = b!.start;
  storyA!.startTime = a!.startTime; storyA!.start = a!.start;
  after.timeline.storyElements = [storyB!, storyA!, storyC!];
  assert.doesNotThrow(() => verifyPrimaryStorylineReorder(preview, before, after));
  for (const change of ["revision", "empty-revision", "invalid-sequence", "source", "range", "outside", "duplicate", "story", "target"] as const) {
    const observed = structuredClone(after);
    if (change === "revision") observed.revision = structuredClone(before.revision);
    if (change === "empty-revision") observed.revision.id = "";
    if (change === "invalid-sequence") observed.revision.sequence = Number.NaN;
    if (change === "source") observed.media[0]!.source = "/other.mov";
    if (change === "range") observed.timeline.clips[0]!.sourceStartTime = { value: "0", timescale: "1" };
    if (change === "outside") observed.timeline.clips[2]!.name = "unexpected";
    if (change === "duplicate") observed.timeline.clips.push(structuredClone(observed.timeline.clips[0]!));
    if (change === "story") observed.timeline.storyElements[0]!.mediaId = "one";
    if (change === "target") observed.timeline.id = "other";
    assert.throws(() => verifyPrimaryStorylineReorder(preview, before, observed), /REORDER_READBACK_FAILED/, change);
  }
});

test("reorder preview rejects invalid baseline revisions and numeric timing", () => {
  for (const change of ["missing-revision", "nan-revision", "fractional-revision", "numeric-start", "numeric-duration", "infinite-property"] as const) {
    const input = fixture();
    if (change === "missing-revision") input.revision.id = "";
    if (change === "nan-revision") input.revision.sequence = Number.NaN;
    if (change === "fractional-revision") input.revision.sequence = 1.5;
    if (change === "numeric-start") input.timeline.clips[2]!.start = 123;
    if (change === "numeric-duration") input.timeline.clips[1]!.duration = 123;
    if (change === "infinite-property") input.timeline.clips[1]!.gainDb = Number.POSITIVE_INFINITY;
    assert.throws(() => previewPrimaryStorylineReorder(input, "a", { kind: "end" }), /REORDER_INVALID/, change);
  }
});
