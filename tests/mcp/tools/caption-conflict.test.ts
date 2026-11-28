import assert from "node:assert/strict";
import { test } from "node:test";
import { captionTitlesConflict, prepareCaptionOperations } from "../../../apps/mcp-server/src/caption-conflict.js";

const title = (id: string, lane: number, start: string, duration: string, timescale = "30") => ({
  id, text: id, lane, startTime: { value: start, timescale }, durationTime: { value: duration, timescale },
});

test("caption conflicts use exact half-open intervals and only the same lane", () => {
  const proposed = [title("new", 1, "30", "30")];
  assert.equal(captionTitlesConflict([title("overlap", 1, "59", "2")], proposed), true);
  assert.equal(captionTitlesConflict([title("before", 1, "0", "30"), title("after", 1, "60", "30")], proposed), false);
  assert.equal(captionTitlesConflict([title("other-lane", 2, "30", "30")], proposed), false);
  assert.equal(captionTitlesConflict([title("subframe", 1, "59999999999999999999", "2", "30000000000000000000")], proposed), true);
  assert.equal(captionTitlesConflict([title("exact-boundary", 1, "60000000000000000000", "1", "30000000000000000000")], proposed), false);
});


test("caption replacements preserve selected title identity and reject unsafe mappings", () => {
  const old = { ...title("old", 1, "30", "30"), text: "Original", style: { color: "white" } };
  const unrelated = title("unrelated", 2, "30", "30");
  const proposed = { ...title("new", 1, "1", "1", "1"), text: "Corrected" };
  const prepared = prepareCaptionOperations([old, unrelated], [proposed], [old.id]);
  assert.deepEqual(prepared.replacedTitleIds, [old.id]);
  assert.deepEqual(prepared.operations, [{ type: "remove-title", titleId: "old" }, { type: "add-title", title: { ...old, text: "Corrected" } }]);
  assert.throws(() => prepareCaptionOperations([old], [proposed], ["missing"]), /CAPTION_REPLACEMENT_INVALID/);
  assert.throws(() => prepareCaptionOperations([old], [proposed], ["old", "old"]), /CAPTION_REPLACEMENT_INVALID/);
  assert.throws(() => prepareCaptionOperations([old, unrelated], [proposed], ["unrelated"]), /CAPTION_REPLACEMENT_INVALID/);
  assert.throws(() => prepareCaptionOperations([old], [{ ...proposed, durationTime: { value: "2", timescale: "1" } }], ["old"]), /CAPTION_REPLACEMENT_INVALID/);
  assert.throws(() => prepareCaptionOperations([old, { ...old, id: "other" }], [proposed], ["old"]), /CAPTION_PREVIEW_OVERLAP/);
  assert.throws(() => prepareCaptionOperations([old], [proposed, { ...proposed, id: "new-2" }], ["old"]), /CAPTION_REPLACEMENT_INVALID/);
  assert.equal(prepareCaptionOperations([unrelated], [proposed], []).operations.length, 1);
});
