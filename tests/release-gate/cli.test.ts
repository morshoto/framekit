import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseGateArgs } from "../../scripts/run-release-gate-args.js";

test("release gate CLI accepts an opt-in headed evidence directory", () => {
  assert.deepEqual(
    parseReleaseGateArgs(["--output-dir", "artifacts/run", "--headed-evidence-dir=headed", `--headed-candidate-commit=${"a".repeat(40)}`], "default"),
    { outputDirectory: "artifacts/run", headedEvidenceDirectory: "headed", headedCandidateCommit: "a".repeat(40) },
  );
});

test("release gate CLI rejects duplicate or unknown options", () => {
  assert.throws(
    () => parseReleaseGateArgs(["--headed-evidence-dir", "one", "--headed-evidence-dir", "two"], "default"),
    /specify --headed-evidence-dir once/,
  );
  assert.throws(
    () => parseReleaseGateArgs(["--unknown"], "default"),
    /only --output-dir, --headed-evidence-dir, and --headed-candidate-commit are supported/,
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


test("release gate CLI validates candidate commit arguments", () => {
  assert.throws(() => parseReleaseGateArgs(["--headed-candidate-commit", "HEAD"], "default"), /40-character commit/);
  assert.throws(() => parseReleaseGateArgs(["--headed-candidate-commit", "a".repeat(40), "--headed-candidate-commit", "b".repeat(40)], "default"), /specify --headed-candidate-commit once/);
});
