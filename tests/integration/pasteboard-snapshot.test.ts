import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_CUT_PASTEBOARD_UTI,
  type FinalCutPasteboardCaptureResult,
  FinalCutPasteboardProvider,
  decodeFinalCutPasteboardArchive,
  decodeFinalCutPasteboardObservation,
} from "@framekit/final-cut";

const target = { projectId: "project-1", sequenceId: "sequence-1" };
const sideEffects = {
  foregroundActivated: true,
  selectionChanged: true,
  clipboardChanged: true,
  clipboardRestored: true,
  focusRestored: false,
} as const;

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
  const input = { uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload, target, sideEffects };
  const first = decodeFinalCutPasteboardObservation(input);
  const second = decodeFinalCutPasteboardObservation(input);

  assert.equal(first.canonical, false);
  assert.equal(first.provenance.uti, FINAL_CUT_PASTEBOARD_UTI);
  assert.equal(first.provenance.sourceVersion, "10.7.1");
  assert.deepEqual(first.target, target);
  assert.deepEqual(first.sideEffects, sideEffects);
  assert.equal(first.payloadDigest, second.payloadDigest);
  assert.deepEqual(first.items, payload.timeline.items);
  assert.deepEqual(first.coverage, {
    containers: "complete",
    occurrences: "partial",
    sourceBindings: "partial",
    timing: "partial",
    anchoredItems: "partial",
  });
  assert.deepEqual(first.unknownFields, [
    "timeline.containerCompleteness",
    "occurrences.completeness",
    "sourceBindings.completeness",
    "timing.completeness",
  ]);
});

test("pasteboard observations fail closed for wrong UTI and incomplete payloads", () => {
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: "public.data", sourceVersion: "10.7.1", payload, target, sideEffects }),
    /FINAL_CUT_PASTEBOARD_UTI_UNSUPPORTED/,
  );
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload: {}, target, sideEffects }),
    /FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE/,
  );
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload, target: { projectId: "", sequenceId: "sequence-1" }, sideEffects }),
    /FINAL_CUT_PASTEBOARD_TARGET_UNAVAILABLE/,
  );
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload: { timeline: { items: [{ ...payload.timeline.items[0], start: -1 }] } }, target, sideEffects }),
    /FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE/,
  );
  assert.throws(
    () => decodeFinalCutPasteboardObservation({ uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: "10.7.1", payload, target, sideEffects: { foregroundActivated: true } as never }),
    /FINAL_CUT_PASTEBOARD_SIDE_EFFECTS_INVALID/,
  );
});

test("pasteboard acquisition is unavailable unless interaction is explicitly permitted and wired", async () => {
  const provider = new FinalCutPasteboardProvider({ sourceVersion: "10.7.1" });
  const blocked = captureResult(await provider.observe({ target, allowInteraction: false, restoreClipboard: true }));
  assert.equal(blocked.status, "user-interaction-required");
  assert.equal(blocked.error?.code, "FINAL_CUT_PASTEBOARD_INTERACTION_REQUIRED");

  const unavailable = captureResult(await provider.observe({ target, allowInteraction: true, restoreClipboard: true }));
  assert.equal(unavailable.status, "unsupported");
  assert.equal(unavailable.error?.code, "FINAL_CUT_PASTEBOARD_CAPTURE_UNAVAILABLE");
});

test("pasteboard provider rejects unbound captures and preserves explicit side effects", async () => {
  const provider = new FinalCutPasteboardProvider({
    sourceVersion: "10.7.1",
    capture: {
      async capture() {
        return {
          status: "captured" as const,
          route: "headed-pasteboard-copy" as const,
          target: { requested: target, observed: { projectId: "other", sequenceId: "sequence-1" }, guarantee: "requested-unverified" as const },
          sideEffects,
          payload,
        };
      },
    },
  });
  const result = captureResult(await provider.observe({ target, allowInteraction: true, restoreClipboard: true }));
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "FINAL_CUT_PASTEBOARD_TARGET_UNVERIFIED");
  assert.deepEqual(result.sideEffects, sideEffects);
});

function captureResult(value: Awaited<ReturnType<FinalCutPasteboardProvider["observe"]>>): FinalCutPasteboardCaptureResult {
  if (!("status" in value)) throw new Error("expected a structured pasteboard capture result");
  return value;
}

test("pasteboard binary archives use the evidence-only keyed-archive decoder", async () => {
  const result = await decodeFinalCutPasteboardArchive(Buffer.from("bplist00fixture"), async () => ({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $top: { root: { "CF$UID": 1 } },
    $objects: ["$null", { value: "evidence" }],
  }));
  assert.equal(result.archive.archiver, "NSKeyedArchiver");
  assert.equal(result.archive.version, 100000);
  assert.match(result.payloadDigest, /^[0-9a-f]{64}$/);
});
