import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  sanitizeFillerRemovalEvidence,
  sanitizeMaskEvidence,
  sanitizeNativeTitleEvidence,
  sanitizePictureInPictureEvidence,
} from "../../scripts/final-cut-evidence.mjs";

const environment = {
  framekitVersion: "0.1.6",
  finalCutVersion: "10.7.1",
  gitCommit: "a".repeat(40),
  nodeVersion: "v22.14.0",
  platform: "darwin",
  architecture: "arm64",
  osVersion: "Darwin",
};

test("headed PIP evidence keeps the exact target and removes native secrets", () => {
  const evidence = sanitizePictureInPictureEvidence({
    schemaVersion: 1,
    evidenceType: "headed-native-picture-in-picture",
    passed: true,
    recordedAt: "2026-09-11T00:00:00.000Z",
    editor: { name: "Final Cut Pro", version: "10.7.1", backend: "final-cut-live" },
    capabilities: { nativePictureInPicture: true, nativeUndo: true, nativeTimelineOccurrenceLocate: true },
    target: {
      project: "Disposable PIP",
      sequenceId: "sequence-1",
      occurrenceId: "occurrence-anchor",
      occurrenceName: "Anchor",
      start: "0/1",
      duration: "10/1",
    },
    placement: {
      requested: { start: "2/1", duration: "4/1", position: { x: 320, y: -180 }, scale: 0.35 },
      observed: { position: { x: 320, y: -180 }, scale: 0.35 },
      beforeRevision: { id: "rev-1" },
      afterRevision: { id: "rev-2" },
      undoRevision: "rev-3",
      anchorOccurrence: { handle: "private-handle" },
      pipMedia: { sourceIdentity: "/private/media/guest.mov" },
      operationId: "private-operation",
    },
    toolResults: [
      { name: "editor.native.picture-in-picture.preview", status: "passed" },
      { name: "editor.native.picture-in-picture.execute", status: "passed" },
      { name: "editor.native.undo", status: "passed" },
    ],
  }, environment);

  assert.equal(evidence.target.occurrenceId, "occurrence-anchor");
  assert.deepEqual(evidence.revisions, { before: "rev-1", after: "rev-2", restored: "rev-3" });
  assert.deepEqual(evidence.verification, { execute: true, undo: true });
  assert.doesNotMatch(JSON.stringify(evidence), /private-handle|sourceIdentity|private-operation|\/private\/media/);
});

test("headed title evidence keeps the project, sequence, and discovered asset", () => {
  const evidence = sanitizeNativeTitleEvidence({
    evidenceType: "headed-native-title-discovery-and-placement",
    passed: true,
    recordedAt: "2026-09-11T00:00:00.000Z",
    project: "Disposable Titles",
    discovery: {
      id: "final-cut:title:basic-title",
      name: "Basic Title",
      vendor: "Final Cut Pro",
      identity: "basic-title",
      backend: "final-cut-accessibility",
      guarantee: "observed",
    },
    target: { sequenceId: "sequence-2" },
    placement: {
      text: "Framekit title proof",
      target: "playhead",
      start: "1/24",
      duration: "3/1",
      beforeRevision: "rev-4",
      afterRevision: "rev-5",
      undoRevision: "rev-6",
      verified: true,
      undo: { command: "Undo", verified: true },
    },
  }, environment);

  assert.deepEqual(evidence.target, { project: "Disposable Titles", sequenceId: "sequence-2" });
  assert.equal(evidence.discovery.assetId, "final-cut:title:basic-title");
  assert.deepEqual(evidence.revisions, { before: "rev-4", after: "rev-5", restored: "rev-6" });
  assert.doesNotMatch(JSON.stringify(evidence), /operationId|diagnostic|sourceIdentity/i);
});

test("headed masking evidence keeps the stable occurrence identity", () => {
  const evidence = sanitizeMaskEvidence({
    evidenceType: "headed-native-mask-placement",
    passed: true,
    recordedAt: "2026-09-11T00:00:00.000Z",
    project: "Disposable Mask",
    target: {
      occurrenceId: "occurrence-mask",
      occurrenceName: "Subject",
      sequenceId: "sequence-3",
      start: "0/1",
      duration: "10/1",
    },
    mask: {
      requested: { mode: "rectangle", bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 } },
      observed: { mode: "rectangle", bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 } },
    },
    revisions: { before: "rev-7", after: "rev-8", restored: "rev-9" },
    verification: { execute: { verified: true }, undo: { verified: true } },
    toolResults: [],
  }, environment);

  assert.equal(evidence.target.occurrenceId, "occurrence-mask");
  assert.deepEqual(evidence.revisions, { before: "rev-7", after: "rev-8", restored: "rev-9" });
  assert.deepEqual(evidence.verification, { execute: true, undo: true });
});

test("all claimed headed runners publish through an allowlisted sanitizer", async () => {
  const root = process.cwd();
  const runners = await Promise.all([
    readFile(join(root, "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8"),
    readFile(join(root, "scripts/final-cut-picture-in-picture-headed-e2e.mjs"), "utf8"),
    readFile(join(root, "scripts/final-cut-title-discovery-headed-e2e.mjs"), "utf8"),
    readFile(join(root, "scripts/final-cut-masking-headed-e2e.mjs"), "utf8"),
    readFile(join(root, "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8"),
  ]);

  assert.match(runners[0], /sanitizeCanonicalEvidence/);
  assert.match(runners[1], /sanitizePictureInPictureEvidence/);
  assert.match(runners[2], /sanitizeNativeTitleEvidence/);
  assert.match(runners[3], /sanitizeMaskEvidence/);
  assert.match(runners[4], /sanitizeFillerRemovalEvidence/);
});

