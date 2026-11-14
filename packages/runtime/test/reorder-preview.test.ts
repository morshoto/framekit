import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSnapshot } from "../src/domain/project.js";
import { previewPrimaryStorylineReorder } from "../src/timeline/reorder-preview.js";

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
