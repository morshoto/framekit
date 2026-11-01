import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { FcpxmlDocumentAdapter } from "../../adapters/final-cut/typescript/src/fcpxml.js";
import { runPublishStages, verifyAcceptanceFixture, verifyPublishedTarget } from "../../scripts/final-cut-publisher-verification.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("publisher QA rejects a gap-only artifact as the acceptance fixture", () => {
  assert.throws(() => verifyAcceptanceFixture({ timeline: { clips: [], storyElements: [] }, media: [] }), /PUBLISH_FIXTURE_MISMATCH/);
});

test("publisher QA checks the independent fixture order, ranges, title and music gain", () => {
  const time = (value: number) => ({ value: String(value), timescale: "1" });
  const snapshot = {
    media: ["a", "b", "c", "music"].map((id) => ({ mediaId: id, source: `/fixture/${id === "music" ? "generated-music.wav" : `clip-${id}.mp4`}` })),
    timeline: {
      frameDuration: { value: "1", timescale: "24" },
      clips: [
        { mediaId: "b", track: 0, startTime: time(0), sourceStartTime: time(5), durationTime: time(8) },
        { mediaId: "music", track: 1, role: "music", gainDb: -12, startTime: time(0), sourceStartTime: time(0), durationTime: time(30) },
        { mediaId: "a", track: 0, startTime: time(8), sourceStartTime: time(10), durationTime: time(12) },
        { mediaId: "c", track: 0, startTime: time(20), sourceStartTime: time(2), durationTime: time(10) },
      ],
      storyElements: [{ kind: "title", text: "FrameKit MVP Test", startTime: time(0), durationTime: time(6), lane: 1 }],
    },
  };
  assert.doesNotThrow(() => verifyAcceptanceFixture(snapshot));
  snapshot.timeline.clips[0]!.sourceStartTime = time(4);
  assert.throws(() => verifyAcceptanceFixture(snapshot), /PUBLISH_FIXTURE_MISMATCH/);
});

test("publisher QA dispatches once and separately confirms native verification", async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const stages: string[] = [];
  const result = await runPublishStages(async (name, args) => {
    calls.push({ name, args });
    if (name === "artifact.publish.preview") return { jobId: "job-1", state: "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/new.fcpbundle" };
    if (calls.length === 2) return { jobId: "job-1", state: "verification-pending", delivery: { route: "headed-apple-event" } };
    return { jobId: "job-1", state: "verified", result: { verified: true } };
  }, { artifactPath: "/tmp/source.fcpxml", transactionId: "txn-1", targetLibraryPath: "/tmp/new.fcpbundle", artifactDigest: "a".repeat(64) }, (stage) => stages.push(stage));
  assert.equal(result.state, "verified");
  assert.deepEqual(stages, ["prepared", "dispatched", "verified"]);
  assert.deepEqual(calls.map(({ name }) => name), ["artifact.publish.preview", "artifact.publish.execute", "artifact.publish.execute"]);
  assert.deepEqual(calls[1]!.args, { jobId: "job-1", confirm: true });
  assert.deepEqual(calls[2]!.args, { jobId: "job-1", confirm: true, confirmVerification: true });
});

test("publisher QA refuses a changed preview digest without dispatch", async () => {
  const calls: string[] = [];
  await assert.rejects(runPublishStages(async (name) => {
    calls.push(name);
    return { jobId: "job-1", state: "awaiting-confirmation", artifactDigest: "b".repeat(64), targetLibraryPath: "/tmp/new.fcpbundle" };
  }, { artifactPath: "/tmp/source.fcpxml", transactionId: "txn-1", targetLibraryPath: "/tmp/new.fcpbundle", artifactDigest: "a".repeat(64) }, () => {}), /PUBLISH_PREVIEW_MISMATCH/);
  assert.deepEqual(calls, ["artifact.publish.preview"]);
});

test("publisher QA stops on ambiguous dispatch without retrying", async () => {
  const calls: string[] = [];
  await assert.rejects(runPublishStages(async (name) => {
    calls.push(name);
    if (name === "artifact.publish.preview") return { jobId: "job-1", state: "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/new.fcpbundle" };
    throw new Error("transport lost");
  }, { artifactPath: "/tmp/source.fcpxml", transactionId: "txn-1", targetLibraryPath: "/tmp/new.fcpbundle", artifactDigest: "a".repeat(64) }, () => {}), /job-1.*do not redispatch/i);
  assert.deepEqual(calls, ["artifact.publish.preview", "artifact.publish.execute"]);
});

test("publisher QA uses the existing verified rough cut without editing the artifact", async () => {
  const calls: Array<{ name: string; args: any }> = [];
  await runPublishStages(async (name, args) => {
    calls.push({ name, args });
    if (name === "artifact.publish.preview") return { jobId: "job-2", state: "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/new.fcpbundle" };
    if (calls.length === 2) return { jobId: "job-2", state: "verification-pending" };
    return { jobId: "job-2", state: "verified", result: { verified: true } };
  }, { artifactPath: "/tmp/source.fcpxml", headlessExecutionId: "execution-1", targetLibraryPath: "/tmp/new.fcpbundle", artifactDigest: "a".repeat(64) }, () => {});
  assert.deepEqual(calls[0]!.args, { artifactPath: "/tmp/source.fcpxml", headlessExecutionId: "execution-1", targetLibraryPath: "/tmp/new.fcpbundle" });
});

test("publisher headed E2E is a separate FCPXML workflow", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const publisherRunner = await readFile(join(repositoryRoot, "scripts/final-cut-publisher-headed-e2e.mjs"), "utf8");
  const nativeRunner = await readFile(join(repositoryRoot, "scripts/final-cut-disposable-native-headed-e2e.mjs"), "utf8");

  assert.equal(typeof packageJson.scripts?.["test:final-cut-publisher-headed"], "string");
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH/);
  assert.match(publisherRunner, /FRAMEKIT_FCPXML_PATH/);
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_LIBRARY_PATH/);
  assert.match(publisherRunner, /targetLibraryPath/);
  assert.match(publisherRunner, /artifact\.inspect/);
  assert.match(publisherRunner, /runPublishStages\(/);
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_APPROVED_DIGEST/);
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION/);
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_EXECUTION_ID/);
  assert.doesNotMatch(publisherRunner, /artifact\.edit/);
  assert.match(publisherRunner, /FcpxmlDocumentAdapter/);
  assert.doesNotMatch(publisherRunner, /callJson\("project\.inspect"/);
  assert.doesNotMatch(publisherRunner, /edit\.undo/);
  assert.match(publisherRunner, /editor\.live\.inspect/);
  assert.equal(publisherRunner.includes("editor.native."), false);
  assert.equal(nativeRunner.includes("artifact.publish"), false);
  assert.match(nativeRunner, /FRAMEKIT_FCPXML_PATH: ""/);
});

test("headed publisher fixture uses DTD-supported sequence identity", async () => {
  const fixturePath = join(repositoryRoot, "tests/fixtures/final-cut-publisher-headed.fcpxml");
  const source = await readFile(fixturePath, "utf8");
  const sequenceAttributes = source.match(/<sequence\b([^>]*)>/)?.[1];
  const snapshot = await new FcpxmlDocumentAdapter(fixturePath, undefined, {
    allowMissingImmutableIdsForReadback: true,
  }).readProject();

  assert.ok(sequenceAttributes, "headed publisher fixture must contain a sequence");
  assert.match(sequenceAttributes, /\bformat="r1"/);
  assert.doesNotMatch(sequenceAttributes, /\b(?:name|uid)=/);
  assert.match(source, /<format\b[^>]*\bid="r1"/);
  assert.equal(snapshot.timeline.name, snapshot.projectName);
});

test("publisher headed E2E rejects missing post-import identities", () => {
  assert.throws(() => verifyPublishedTarget({
    result: {
      verified: true,
      semanticReadback: { verified: true, expectedDigest: "approved", observedDigest: "approved", checked: ["timeline-duration-and-frame-rate", "clip-order-and-source-ranges", "editable-title-content-and-timing", "connected-audio-source-role-gain-and-timing", "source-media-bindings"] },
      sourceMediaIntegrity: { unchanged: true, digests: [] },
      createdTarget: { projectName: "Imported", sequenceName: "Main" },
      activeProject: { before: { id: "before-project" }, after: {} },
    },
    beforeLive: { project: { id: "before-project" }, sequence: { id: "before-sequence" } },
    afterLive: { project: { name: "Imported" }, sequence: { name: "Main" } },
    expectedProject: "Imported",
    expectedSequence: "Main",
    sourceSequence: "Main",
  }), /FINAL_CUT_E2E_PUBLISH_TARGET_VERIFICATION_FAILED/);
});

test("publisher headed E2E rejects mismatched semantic readback", () => {
  assert.throws(() => verifyPublishedTarget({
    result: {
      verified: true,
      semanticReadback: { verified: true, expectedDigest: "approved", observedDigest: "different", checked: ["clips"] },
      sourceMediaIntegrity: { unchanged: true, digests: [] },
      createdTarget: { projectName: "Imported", sequenceName: "Main", projectId: "project", sequenceId: "sequence" },
      activeProject: { before: { id: "before" }, after: { id: "project" } },
    },
    beforeLive: { project: { id: "before" }, sequence: { id: "before-sequence" } },
    afterLive: { project: { id: "project", name: "Imported" }, sequence: { id: "sequence", name: "Main" } },
    expectedProject: "Imported",
    expectedSequence: "Main",
    sourceSequence: "Main",
  }), /FINAL_CUT_E2E_PUBLISH_SEMANTIC_READBACK_FAILED/);
});

test("publisher headed E2E rejects incomplete semantic coverage", () => {
  assert.throws(() => verifyPublishedTarget({
    result: {
      verified: true,
      semanticReadback: { verified: true, expectedDigest: "a".repeat(64), observedDigest: "a".repeat(64), checked: ["clip-order-and-source-ranges"] },
      sourceMediaIntegrity: { unchanged: true, digests: [] },
      createdTarget: { projectName: "Imported", sequenceName: "Main", projectId: "project", sequenceId: "sequence" },
      activeProject: { before: { id: "before" }, after: { id: "project" } },
    },
    beforeLive: { project: { id: "before" }, sequence: { id: "before-sequence" } },
    afterLive: { project: { id: "project" }, sequence: { id: "sequence" } },
    expectedProject: "Imported", expectedSequence: "Main", sourceSequence: "Main",
  }), /PUBLISH_SEMANTIC_COVERAGE_INCOMPLETE/);
});
