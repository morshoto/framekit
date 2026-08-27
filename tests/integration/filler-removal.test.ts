import assert from "node:assert/strict";
import test from "node:test";
import { planFillerRemoval } from "@framekit/runtime";

test("filler planning selects high-confidence words and preserves a short pause", () => {
  const candidates = planFillerRemoval([
    { text: "So", start: 0, end: 0.3, confidence: 0.99 },
    { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    { text: "what", start: 1.6, end: 2, confidence: 0.99 },
    { text: "well", start: 2.2, end: 2.5, confidence: 0.7, filler: true },
  ], { start: 0, end: 2.5 });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    word: { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    range: {
      start: 0.4,
      end: 1.1,
      startTime: { value: "2", timescale: "5" },
      durationTime: { value: "7", timescale: "10" },
    },
  });
});

test("filler planning removes only the word when adjacent speech boundaries are uncertain", () => {
  const candidates = planFillerRemoval([
    { text: "hello", start: 0, end: 1, confidence: 0.99 },
    { text: "um", start: 1.1, end: 1.3, confidence: 0.98, filler: true },
    { text: "world", start: 1.5, end: 2, confidence: 0.99 },
  ], { start: 0, end: 2 });

  assert.deepEqual(candidates[0]?.range, {
    start: 1.1,
    end: 1.3,
    startTime: { value: "11", timescale: "10" },
    durationTime: { value: "1", timescale: "5" },
  });
});

test("filler planning returns multiple ranges from latest to earliest", () => {
  const candidates = planFillerRemoval([
    { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    { text: "then", start: 0.8, end: 1.1, confidence: 0.99 },
    { text: "uh", start: 1.2, end: 1.4, confidence: 0.97, filler: true },
  ], { start: 0, end: 2 });

  assert.deepEqual(candidates.map(({ range }) => range.start), [1.2, 0.4]);
});

test("filler planning rejects malformed speech boundaries", () => {
  assert.throws(
    () => planFillerRemoval([
      { text: "um", start: 1, end: 0.5, confidence: 0.98, filler: true },
    ], { start: 0, end: 2 }),
    /ANALYSIS_INVALID: speech word boundaries/,
  );
});
