import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { classifyFinalCutFcpxmlExperiment } from "@framekit/final-cut";

function observation(overrides: Record<string, unknown> = {}) {
  return {
    artifact: { format: "fcpxml" as const, version: "1.11", digest: "a".repeat(64), valid: true },
    process: "running" as const,
    frontmost: "final-cut" as const,
    console: { state: "unlocked" as const, source: "IOConsoleLocked", retryable: false },
    library: { state: "observed" as const, evidence: "filesystem" as const },
    log: { state: "not-collected" as const, lineCount: 0 },
    ...overrides,
  };
}

test("classifies a locked console as an exact, non-mutating blocker", () => {
  const result = classifyFinalCutFcpxmlExperiment(observation({
    console: { state: "locked", source: "IOConsoleLocked", retryable: false },
  }));

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [{
    code: "FINAL_CUT_NATIVE_CONSOLE_LOCKED",
    retryable: false,
    message: "The macOS console is locked; no headed FCPXML import was attempted",
  }]);
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.nativeImportVerified, false);
  assert.equal(result.safeToOverwrite, false);
});

test("keeps an exact unknown lock signal retryable and fail closed", () => {
  const result = classifyFinalCutFcpxmlExperiment(observation({
    console: { state: "unknown", source: "conflict", retryable: true },
  }));

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers[0], {
    code: "FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN",
    retryable: true,
    message: "macOS did not expose one consistent supported console lock state",
  });
  assert.equal(result.capabilities.headedImport, "blocked");
});

test("separates artifact-only evidence from headed readiness", () => {
  const artifactOnly = classifyFinalCutFcpxmlExperiment(observation({
    process: "not-running",
    frontmost: "unknown",
    library: { state: "not-inspected", evidence: "none" },
  }));
  const ready = classifyFinalCutFcpxmlExperiment(observation());

  assert.equal(artifactOnly.status, "artifact-only");
  assert.equal(artifactOnly.capabilities.artifactRead, "verified");
  assert.equal(artifactOnly.capabilities.headedImport, "blocked");
  assert.equal(artifactOnly.nativeImportVerified, false);
  assert.equal(ready.status, "headed-preflight-ready");
  assert.equal(ready.capabilities.headedImport, "preflight-only");
  assert.equal(ready.capabilities.targetBoundReadback, "unavailable");
  assert.equal(ready.mutationAttempted, false);
});

test("rejects invalid artifact observations before environment classification", () => {
  assert.throws(
    () => classifyFinalCutFcpxmlExperiment(observation({
      artifact: { format: "fcpxml", version: "1.11", digest: "not-a-digest", valid: false },
    })),
    /FCPXML_ARTIFACT_INVALID/,
  );
});

test("read-only experiment runner records artifact and environment evidence without mutation", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-fcpxml-console-experiment.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));

  assert.equal(packageJson.scripts["test:final-cut-fcpxml-console-experiment"], "node --import tsx scripts/final-cut-fcpxml-console-experiment.mjs");
  assert.match(runner, /FRAMEKIT_FCPXML_PATH/);
  assert.match(runner, /FcpxmlDocumentAdapter/);
  assert.match(runner, /pgrep/);
  assert.match(runner, /IOConsoleLocked/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_LIBRARY_PATH/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_LOG_PATH/);
  assert.doesNotMatch(runner, /\b(?:writeFile|rename|unlink)\b/);
  assert.match(runner, /classifyFinalCutFcpxmlExperiment/);
  assert.match(runner, /artifactReadback/);
});
