import assert from "node:assert/strict";
import test from "node:test";
import { parseFillerRemovalOutputDirectory } from "../../scripts/run-filler-removal-benchmark-args.js";

test("filler-removal CLI accepts one output-directory form", () => {
  assert.equal(
    parseFillerRemovalOutputDirectory(["--output-dir", "first"], "default"),
    "first",
  );
  assert.equal(
    parseFillerRemovalOutputDirectory(["--output-dir=first"], "default"),
    "first",
  );
  assert.equal(parseFillerRemovalOutputDirectory([], "default"), "default");
});

test("filler-removal CLI rejects duplicate and unsupported arguments", () => {
  for (const args of [
    ["--output-dir", "first", "--output-dir", "second"],
    ["--output-dir=first", "--output-dir", "second"],
    ["--output-dir", "first", "trailing"],
    ["--unsupported"],
  ]) {
    assert.throws(
      () => parseFillerRemovalOutputDirectory(args, "default"),
      /USAGE:/,
      args.join(" "),
    );
  }
  assert.throws(
    () => parseFillerRemovalOutputDirectory(["--output-dir"], "default"),
    /USAGE: --output-dir requires a path/,
  );
  assert.throws(
    () => parseFillerRemovalOutputDirectory(["--output-dir", "--other"], "default"),
    /USAGE: --output-dir requires a path/,
  );
});
