import assert from "node:assert/strict";
import test from "node:test";
import { assessBuildAlignment } from "../../apps/mcp-server/src/build-alignment.js";

const runtime = { version: "0.1.11", commit: "runtime-commit" };

test("local validation accepts matching runtime and extension fingerprints", () => {
  const alignment = assessBuildAlignment(runtime, runtime);

  assert.equal(alignment.status, "matched");
  assert.equal(alignment.message, "runtime and extension fingerprints match");
});

test("local validation reports a missing extension fingerprint", () => {
  const alignment = assessBuildAlignment(runtime, undefined);

  assert.equal(alignment.status, "missing");
  assert.match(alignment.message, /extension fingerprint is unavailable/);
});

test("local validation reports a stale extension fingerprint", () => {
  const alignment = assessBuildAlignment(runtime, { ...runtime, commit: "stale-commit" });

  assert.equal(alignment.status, "mismatched");
  assert.match(alignment.message, /extension commit stale-commit does not match runtime commit runtime-commit/);
});

test("local validation compares both sides with an explicit checkout target", () => {
  const alignment = assessBuildAlignment(runtime, runtime, "intended-commit");

  assert.equal(alignment.status, "mismatched");
  assert.match(alignment.message, /runtime commit runtime-commit does not match target commit intended-commit/);
});
