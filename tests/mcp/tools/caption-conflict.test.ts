import assert from "node:assert/strict";
import { test } from "node:test";
import { captionTitlesConflict } from "../../../apps/mcp-server/src/caption-conflict.js";

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
