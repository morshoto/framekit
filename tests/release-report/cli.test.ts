import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseReportArgs } from "../../scripts/release-report/args.js";

test("release report CLI accepts explicit reproducible inputs", () => {
  assert.deepEqual(
    parseReleaseReportArgs([
      "--baseline-tag", "v0.1.0",
      "--current-tag", "v0.2.0",
      "--baseline-coverage", "baseline.json",
      "--current-coverage", "current.json",
      "--data-file", "github.json",
      "--output-dir", "artifacts/release-report",
    ], "default-output"),
    {
      baselineTag: "v0.1.0",
      currentTag: "v0.2.0",
      baselineCoveragePath: "baseline.json",
      currentCoveragePath: "current.json",
      dataFilePath: "github.json",
      outputDirectory: "artifacts/release-report",
    },
  );
});

test("release report CLI rejects missing, duplicate, and unsupported arguments", () => {
  for (const args of [
    [],
    ["--baseline-tag", "v0.1.0"],
    ["--baseline-tag", "v0.1.0", "--current-tag", "v0.2.0", "--current-tag", "v0.3.0"],
    ["--baseline-tag", "v0.1.0", "--current-tag", "v0.2.0", "--unsupported"],
  ]) {
    assert.throws(() => parseReleaseReportArgs(args, "default-output"), /USAGE:/, args.join(" "));
  }
});
