import assert from "node:assert/strict";
import test from "node:test";
import { assessQaPreflight, type QaPreflightObservation } from "../../../scripts/native-qa/preflight.js";

const identity = { candidateCommit: "a".repeat(40), candidateTree: "b".repeat(40), packageDigest: "1".repeat(64), mcpDigest: "8".repeat(64), pluginDigest: "2".repeat(64), extensionDigest: "3".repeat(64) };
const ready: QaPreflightObservation = { headlessPassed: true, expected: identity, observed: { ...identity }, console: "unlocked", finalCut: "frontmost", recovery: "clear" };

test("reports separate authorization as the next step without dispatch", () => {
  const result = assessQaPreflight(ready);
  assert.deepEqual(result, { state: "AWAITING_AUTHORIZATION", nextAction: "authorize-exact-operation", dispatchAllowed: false, evidence: "preflight-only" });
});

test("identity mismatches block before native action", () => {
  for (const key of Object.keys(identity) as Array<keyof typeof identity>) {
    const actual = { ...identity, [key]: (key.startsWith("candidate") ? "c".repeat(40) : "4".repeat(64)) };
    const result = assessQaPreflight({ ...ready, observed: actual });
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.nextAction, "resolve-identity-mismatch");
    assert.equal(result.dispatchAllowed, false);
  }
});

test("locked console and non-frontmost app yield bounded waits", () => {
  assert.deepEqual(assessQaPreflight({ ...ready, console: "locked" }), { state: "WAITING", nextAction: "unlock-console", dispatchAllowed: false, evidence: "preflight-only" });
  assert.deepEqual(assessQaPreflight({ ...ready, finalCut: "not-frontmost" }), { state: "WAITING", nextAction: "make-final-cut-frontmost", dispatchAllowed: false, evidence: "preflight-only" });
});

test("unresolved recovery, missing observations and failed headless checks fail closed", () => {
  for (const observation of [
    { ...ready, recovery: "required" }, { ...ready, recovery: "unavailable" },
    { ...ready, headlessPassed: false }, { ...ready, console: "unknown" },
    { ...ready, finalCut: "unknown" }, { ...ready, observed: { ...identity, extensionDigest: "" } },
  ]) {
    const result = assessQaPreflight(observation as QaPreflightObservation);
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.dispatchAllowed, false);
  }
});


test("a mismatched MCP fingerprint blocks even when other identities match", () => {
  const result = assessQaPreflight({ ...ready, observed: { ...identity, mcpDigest: "9".repeat(64) } });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.nextAction, "resolve-identity-mismatch");
  assert.equal(result.dispatchAllowed, false);
});

test("reports which identities differ without exposing fingerprint values", () => {
  const result = assessQaPreflight({ ...ready, observed: { ...identity, mcpDigest: "9".repeat(64), pluginDigest: "7".repeat(64) } });
  assert.deepEqual(result.mismatchedIdentities, ["mcpDigest", "pluginDigest"]);
  assert.equal(JSON.stringify(result).includes("9".repeat(64)), false);
});

test("headless orchestration checks candidate and artifact before render", async () => {
  const { runHeadlessQaChecks } = await import("../../../scripts/native-qa/headless-checks.js");
  const calls: string[] = [];
  const result = await runHeadlessQaChecks({
    candidateMatches: async () => { calls.push("candidate"); return true; },
    verifyArtifact: async () => { calls.push("artifact"); },
    runRenderContract: async () => { calls.push("render"); },
  });
  assert.equal(result, "render-contract-passed");
  assert.deepEqual(calls, ["candidate", "artifact", "render", "candidate"]);
});

test("failed candidate or artifact checks never run the render test", async () => {
  const { runHeadlessQaChecks } = await import("../../../scripts/native-qa/headless-checks.js");
  let renderCalls = 0;
  let artifactCalls = 0;
  const mismatch = await runHeadlessQaChecks({
    candidateMatches: async () => false,
    verifyArtifact: async () => { artifactCalls++; },
    runRenderContract: async () => { renderCalls++; },
  });
  assert.equal(mismatch, "candidate-mismatch");
  assert.equal(artifactCalls, 0);
  const invalidArtifact = await runHeadlessQaChecks({
    candidateMatches: async () => true,
    verifyArtifact: async () => { throw new Error("QA_ARTIFACT_DIGEST_MISMATCH"); },
    runRenderContract: async () => { renderCalls++; },
  });
  assert.equal(invalidArtifact, "artifact-digest-mismatch");
  assert.equal(renderCalls, 0);
});

test("a changed candidate invalidates the completed headless check", async () => {
  const { runHeadlessQaChecks } = await import("../../../scripts/native-qa/headless-checks.js");
  let calls = 0;
  const result = await runHeadlessQaChecks({
    candidateMatches: async () => ++calls === 1,
    verifyArtifact: async () => {},
    runRenderContract: async () => {},
  });
  assert.equal(result, "candidate-changed");
});
