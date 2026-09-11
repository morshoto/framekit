import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assessReleaseProvenance,
  loadNativeEditingManifest,
  summarizeHeadedEvidence,
} from "./native-editing.js";
import { runReleaseGate } from "./runner.js";

test("v0.1.6 manifest names every evidence tier and workflow", () => {
  const manifest = loadNativeEditingManifest();

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.gate, "v0.1.6-native-editing");
  assert.equal(manifest.releaseVersion, "0.1.6");
  assert.deepEqual(
    manifest.evidenceTiers.map((tier) => tier.id),
    ["deterministic", "fcpxml-artifact", "metadata-only", "canonical-live", "headed-native"],
  );
  assert.deepEqual(
    manifest.workflows.map((workflow) => workflow.id),
    [
      "canonical-live",
      "picture-in-picture",
      "built-in-title-discovery",
      "masking",
      "filler-removal",
      "dialogue-normalization",
    ],
  );
  assert.equal(
    manifest.workflows.find((workflow) => workflow.id === "picture-in-picture")?.headedRunner,
    "scripts/final-cut-picture-in-picture-headed-e2e.mjs",
  );
  const dialogue = manifest.workflows.find((workflow) => workflow.id === "dialogue-normalization");
  assert.deepEqual(dialogue?.evidenceTiers, ["deterministic", "fcpxml-artifact", "canonical-live"]);
  assert.deepEqual(dialogue?.evidenceTypes, []);
  assert.equal(dialogue?.headedRunner, undefined);
});

test("headed evidence is reduced to a target, revision, verification, and restoration summary", () => {
  const workflow = loadNativeEditingManifest().workflows.find((candidate) => candidate.id === "picture-in-picture");
  assert.ok(workflow);

  const summary = summarizeHeadedEvidence({
    schemaVersion: 1,
    evidenceType: "headed-native-picture-in-picture",
    passed: true,
    recordedAt: "2026-09-11T00:00:00.000Z",
    environment: {
      framekitVersion: "0.1.6",
      finalCutVersion: "10.7.1",
      gitCommit: "a".repeat(40),
      nodeVersion: "v22.14.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin",
    },
    editor: { name: "Final Cut Pro", version: "10.7.1", backend: "final-cut-live" },
    capabilities: { nativePictureInPicture: true, nativeUndo: true },
    target: { project: "Disposable PIP", sequenceId: "sequence-1", occurrenceId: "occurrence-1" },
    placement: {
      project: "Disposable PIP",
      anchorOccurrence: { handle: "private-occurrence-handle", start: "0/1", duration: "10/1" },
      pipMedia: { name: "Guest", sourceIdentity: "/private/media/guest.mov" },
      beforeRevision: "rev-1",
      afterRevision: "rev-2",
      undoRevision: "rev-3",
      operationId: "private-operation-id",
      undoOperationId: "private-undo-id",
      undoVerified: { verified: true },
      observed: { position: { x: 320, y: -180 }, scale: 0.35 },
    },
  }, workflow);

  assert.equal(summary.workflowId, "picture-in-picture");
  assert.equal(summary.evidenceType, "headed-native-picture-in-picture");
  assert.equal(summary.status, "verified");
  assert.deepEqual(summary.target, { project: "Disposable PIP", sequenceId: "sequence-1", occurrenceId: "occurrence-1" });
  assert.deepEqual(summary.revision, { before: "rev-1", after: "rev-2", restored: "rev-3" });
  assert.deepEqual(summary.verification, { execute: true, undo: true });
  assert.equal(summary.environment.gitCommit, "a".repeat(40));
  assert.doesNotMatch(JSON.stringify(summary), /private-occurrence|sourceIdentity|operationId|diagnostic/i);
});

test("headed evidence omits path-like target identities", () => {
  const workflow = loadNativeEditingManifest().workflows.find((candidate) => candidate.id === "picture-in-picture");
  assert.ok(workflow);

  const summary = summarizeHeadedEvidence({
    evidenceType: "headed-native-picture-in-picture",
    passed: true,
    environment: { framekitVersion: "0.1.6", finalCutVersion: "10.7.1", gitCommit: "a".repeat(40) },
    project: "Disposable PIP",
    target: {
      sequenceId: "sequence-1",
      occurrenceId: "occurrence-1",
      occurrenceName: "Guest",
      sourceIdentity: "C:\\Users\\example\\clip",
    },
    placement: {
      beforeRevision: "rev-1",
      afterRevision: "rev-2",
      undoRevision: "rev-3",
      observed: { position: { x: 320, y: -180 }, scale: 0.35 },
      undoVerified: { verified: true },
    },
  }, workflow);

  assert.deepEqual(summary.target, { project: "Disposable PIP", sequenceId: "sequence-1", occurrenceId: "occurrence-1", occurrenceName: "Guest" });
});

test("headed evidence requires a verified rollback for mutating workflows", () => {
  const workflow = loadNativeEditingManifest().workflows.find((candidate) => candidate.id === "masking");
  assert.ok(workflow);

  assert.throws(
    () => summarizeHeadedEvidence({
      evidenceType: "headed-native-mask-placement",
      passed: true,
      environment: { framekitVersion: "0.1.6", finalCutVersion: "10.7.1", gitCommit: "b".repeat(40) },
      project: "Disposable Mask",
      target: { sequenceId: "sequence-1", occurrenceId: "clip-1" },
      revisions: { before: "rev-1", after: "rev-2", restored: "rev-3" },
      verification: { execute: { verified: true } },
    }, workflow),
    /rollback|undo/i,
  );
});

test("headed occurrence workflows require a stable occurrence identity", () => {
  const workflow = loadNativeEditingManifest().workflows.find((candidate) => candidate.id === "picture-in-picture");
  assert.ok(workflow);

  assert.throws(
    () => summarizeHeadedEvidence({
      evidenceType: "headed-native-picture-in-picture",
      passed: true,
      environment: { framekitVersion: "0.1.6", finalCutVersion: "10.7.1", gitCommit: "c".repeat(40) },
      target: { project: "Disposable PIP", sequenceId: "sequence-1" },
      placement: {
        beforeRevision: "rev-1",
        afterRevision: "rev-2",
        undoRevision: "rev-3",
        observed: { position: { x: 320, y: -180 }, scale: 0.35 },
        undoVerified: { verified: true },
      },
    }, workflow),
    /occurrence identity/i,
  );
});

test("release provenance verifies aligned versions, tag, workflow, npm, and checksums", () => {
  const report = assessReleaseProvenance({
    packageManifest: { name: "@morshoto/framekit", version: "0.1.6", private: false },
    pluginManifest: { name: "framekit", version: "0.1.6" },
    serverVersion: "0.1.6",
    releaseTag: "v0.1.6",
    githubRelease: { tagName: "v0.1.6", draft: false },
    workflow: { status: "completed", conclusion: "success", headSha: "c".repeat(40), tagSha: "c".repeat(40) },
    npmVersion: "0.1.6",
    nativeAssets: [
      { name: "FramekitFinalCutWorkflow-0.1.6.zip", sha256: "d".repeat(64) },
      {
        name: "FramekitFinalCutWorkflow-0.1.6.zip.sha256",
        sha256: "e".repeat(64),
        content: `${"d".repeat(64)}  FramekitFinalCutWorkflow-0.1.6.zip\n`,
      },
    ],
  });

  assert.equal(report.releaseReady, true);
  assert.ok(report.checks.every((check) => check.status === "verified"));
});

test("release provenance rejects workflow evidence without a tag commit", () => {
  const report = assessReleaseProvenance({
    packageManifest: { version: "0.1.6" },
    pluginManifest: { version: "0.1.6" },
    serverVersion: "0.1.6",
    workflow: { status: "completed", conclusion: "success", headSha: "c".repeat(40) },
  });

  assert.equal(report.checks.find((check) => check.name === "release-workflow")?.status, "failed");
});

test("release provenance rejects a checksum file for a different archive", () => {
  const report = assessReleaseProvenance({
    packageManifest: { version: "0.1.6" },
    pluginManifest: { version: "0.1.6" },
    serverVersion: "0.1.6",
    nativeAssets: [
      { name: "FramekitFinalCutWorkflow-0.1.6.zip", sha256: "d".repeat(64) },
      {
        name: "FramekitFinalCutWorkflow-0.1.6.zip.sha256",
        sha256: "e".repeat(64),
        content: `${"f".repeat(64)}  FramekitFinalCutWorkflow-0.1.6.zip\n`,
      },
    ],
  });

  assert.equal(report.checks.find((check) => check.name === "native-assets")?.status, "failed");
  assert.match(report.checks.find((check) => check.name === "native-assets")?.detail ?? "", /checksum/i);
});

test("missing external release state is unrun and cannot be release success", () => {
  const report = assessReleaseProvenance({
    packageManifest: { name: "@morshoto/framekit", version: "0.1.5", private: false },
    pluginManifest: { name: "framekit", version: "0.1.5" },
    serverVersion: "0.1.5",
  });

  assert.equal(report.releaseReady, false);
  assert.ok(report.checks.some((check) => check.name === "github-release" && check.status === "unrun"));
  assert.ok(report.checks.some((check) => check.name === "native-assets" && check.status === "unrun"));
  assert.doesNotMatch(report.summary, /release ready/i);
});

test("release gate keeps repository-owned provenance values authoritative", async () => {
  const report = await runReleaseGate({
    provenance: {
      packageManifest: { version: "9.9.9" },
      pluginManifest: { version: "9.9.9" },
      serverVersion: "9.9.9",
    } as never,
  });

  assert.match(report.provenance.checks.find((check) => check.name === "package-plugin-versions")?.detail ?? "", /0\.1\.5/);
  assert.match(report.provenance.checks.find((check) => check.name === "mcp-server-version")?.detail ?? "", /0\.1\.5/);
});

test("release gate reports each v0.1.6 evidence tier independently", async () => {
  const report = await runReleaseGate({ generatedAt: "2026-09-11T00:00:00.000Z" });

  assert.equal(report.gate, "v0.1.6-native-editing");
  assert.equal(report.manifestVersion, "2026-09-11");
  assert.equal(report.deterministic.passed, true);
  assert.equal(report.evidenceTiers.deterministic.status, "verified");
  assert.equal(report.evidenceTiers["fcpxml-artifact"].status, "verified");
  assert.equal(report.evidenceTiers["metadata-only"].status, "verified");
  assert.equal(report.evidenceTiers["canonical-live"].status, "unsupported");
  assert.equal(report.evidenceTiers["headed-native"].status, "unrun");
  assert.deepEqual(
    report.workflowMatrix.map((workflow) => workflow.workflowId),
    [
      "canonical-live",
      "picture-in-picture",
      "built-in-title-discovery",
      "masking",
      "filler-removal",
      "dialogue-normalization",
    ],
  );
  assert.ok(report.evidenceTiers["metadata-only"].preflight.unavailableReason);
  assert.doesNotMatch(JSON.stringify(report), /operationId|sourceIdentity|\/private\/media/i);
});

test("partial headed evidence cannot promote the headed tier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headed-evidence-"));
  try {
    await writeFile(join(directory, "pip.json"), JSON.stringify({
      evidenceType: "headed-native-picture-in-picture",
      passed: true,
      environment: { framekitVersion: "0.1.6", finalCutVersion: "10.7.1", gitCommit: "a".repeat(40) },
      placement: {
        project: "Disposable PIP",
        target: { sequenceId: "sequence-1", occurrenceId: "occurrence-1" },
        beforeRevision: "rev-1",
        afterRevision: "rev-2",
        undoRevision: "rev-3",
        observed: { position: { x: 320, y: -180 }, scale: 0.35 },
        undoVerified: { verified: true },
      },
    }), "utf8");

    const report = await runReleaseGate({ headedEvidenceDirectory: directory });

    assert.equal(report.evidenceTiers["headed-native"].status, "failed");
    assert.equal(report.evidenceTiers["headed-native"].passed, false);
    assert.equal(report.evidenceTiers["headed-native"].workflows.find((workflow) => workflow.workflowId === "picture-in-picture")?.status, "verified");
    assert.equal(report.evidenceTiers["headed-native"].workflows.find((workflow) => workflow.workflowId === "masking")?.status, "unrun");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
