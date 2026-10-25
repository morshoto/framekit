import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { FcpxmlDocumentAdapter } from "../../adapters/final-cut/typescript/src/fcpxml.js";
import { verifyPublishedTarget } from "../../scripts/final-cut-publisher-verification.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
  assert.match(publisherRunner, /artifact\.publish/);
  assert.match(publisherRunner, /editor\.live\.inspect/);
  assert.match(publisherRunner, /confirm: true/);
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
      semanticReadback: { verified: true, expectedDigest: "approved", observedDigest: "approved", checked: ["clips"] },
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
