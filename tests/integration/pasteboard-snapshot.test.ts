import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_CUT_PASTEBOARD_UTI,
  decodeFinalCutPasteboardObservation,
} from "@framekit/final-cut";

const payload = {
  timeline: {
    items: [{
      occurrenceId: "occurrence-1",
      resourceId: "resource-1",
      start: 0,
      duration: 4,
      lane: 0,
      role: "video",
    }],
    anchoredItems: [],
  },
};

test("pasteboard observations are deterministic and explicitly non-canonical", () => {
  const input = { uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload };
  const first = decodeFinalCutPasteboardObservation(input);
  const second = decodeFinalCutPasteboardObservation(input);

  assert.equal(first.canonical, false);
  assert.equal(first.provenance.uti, FINAL_CUT_PASTEBOARD_UTI);
  assert.equal(first.provenance.sourceVersion, "10.7.1");
  assert.equal(first.payloadDigest, second.payloadDigest);
  assert.deepEqual(first.items, payload.timeline.items);
  assert.deepEqual(first.coverage, {
    containers: "complete",
    occurrences: "observed",
    sourceBindings: "observed",
    timing: "observed",
    anchoredItems: "complete",
  });
});

test("pasteboard observations fail closed for wrong UTI and incomplete payloads", () => {
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: "public.data", sourceVersion: "10.7.1", payload }),
    /FINAL_CUT_PASTEBOARD_UTI_UNSUPPORTED/,
  );
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload: {} }),
    /FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE/,
  );
});
