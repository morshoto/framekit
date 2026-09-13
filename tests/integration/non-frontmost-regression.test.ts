import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceFromPreflight,
  NON_FRONTMOST_EVIDENCE_TIERS,
} from "../../scripts/non-frontmost-evidence.mjs";

test("non-frontmost evidence maps every supported preflight tier", () => {
  assert.deepEqual(NON_FRONTMOST_EVIDENCE_TIERS, [
    "deterministic",
    "artifact",
    "metadata-only",
    "canonical-live",
    "headed-native",
  ]);

  assert.deepEqual(evidenceFromPreflight({
    mode: "fixture",
    documentMode: "fixture",
    processMode: "headless",
    backend: "fixture",
  }), {
    evidenceTier: "deterministic",
    provider: "fixture",
    documentMode: "fixture",
    processMode: "headless",
  });
});
