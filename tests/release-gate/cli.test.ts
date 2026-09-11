import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseGateArgs } from "../../scripts/run-release-gate-args.js";

test("release gate CLI accepts an opt-in headed evidence directory", () => {
  assert.deepEqual(
    parseReleaseGateArgs(["--output-dir", "artifacts/run", "--headed-evidence-dir=headed"], "default"),
    { outputDirectory: "artifacts/run", headedEvidenceDirectory: "headed" },
  );
});

test("release gate CLI rejects duplicate or unknown options", () => {
  assert.throws(
    () => parseReleaseGateArgs(["--headed-evidence-dir", "one", "--headed-evidence-dir", "two"], "default"),
    /specify --headed-evidence-dir once/,
  );
  assert.throws(
    () => parseReleaseGateArgs(["--unknown"], "default"),
    /only --output-dir and --headed-evidence-dir are supported/,
  );
  assert.throws(
    () => parseReleaseGateArgs(["--output-dir"], "default"),
    /--output-dir requires a path/,
  );
  assert.throws(
    () => parseReleaseGateArgs(["--headed-evidence-dir"], "default"),
    /--headed-evidence-dir requires a path/,
  );
});
