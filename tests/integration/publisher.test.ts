import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutProjectPublisher } from "@framekit/final-cut";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("FCPXML publisher imports a validated artifact as a new project", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-"));
  const artifactDirectory = join(directory, "artifact with spaces");
  await mkdir(artifactDirectory);
  const sourcePath = join(artifactDirectory, "published project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="published-project" name="Published Edit"><sequence uid="published-sequence" name="Published Sequence" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const scripts: string[] = [];
  let liveStateCalls = 0;
  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async (script) => {
      scripts.push(script);
      return "imported";
    },
    liveState: async () => ({
      project: liveStateCalls++ === 0
        ? { id: "project-before", name: "Existing Project" }
        : { id: "project-2", name: "Published Edit" },
      sequence: liveStateCalls <= 1
        ? { id: "sequence-before", name: "Existing Sequence", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } }
        : { id: "sequence-2", name: "Published Sequence", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
      playheadTime: { value: "0", timescale: "1" },
      sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
      revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
    }),
  }).publishNewProject({
    sourceTransactionId: "txn-publish-1",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  });

  assert.equal(result.verified, true);
  assert.equal(result.sourceTransactionId, "txn-publish-1");
  assert.equal(result.projectName, "Published Edit");
  assert.equal(result.liveProject, "Published Edit");
  assert.equal(result.liveSequence, "Published Sequence");
  assert.deepEqual(result.sourceTarget, { kind: "artifact", artifactPath: sourcePath });
  assert.deepEqual(result.createdTarget, {
    kind: "editor.project",
    projectId: "project-2",
    sequenceId: "sequence-2",
    projectName: "Published Edit",
    sequenceName: "Published Sequence",
  });
  assert.deepEqual(result.activeProject, {
    before: { id: "project-before", name: "Existing Project" },
    after: { id: "project-2", name: "Published Edit" },
    changed: true,
  });
  assert.match(scripts[0], /waitForMenuItem/);
  assert.match(scripts[0], /waitForImportSheet/);
  assert.match(scripts[0], /waitForSubmenu\(importMenuItem, "Import"/);
  assert.match(scripts[0], /my waitForMenuItem/);
  assert.match(scripts[0], /my waitForSubmenu/);
  assert.match(scripts[0], /my waitForWindow/);
  assert.match(scripts[0], /my waitForImportSheet/);
  assert.match(scripts[0], /my locateImportPathField/);
  assert.match(scripts[0], /my waitForImportSheetDismissal/);
  assert.match(scripts[0], /my waitForImportWindowDismissal/);
  assert.match(scripts[0], /my cancelImportIfOpen/);
  assert.match(scripts[0], /perform action "AXPress"/);
  assert.match(scripts[0], /keystroke "g" using \{command down, shift down\}/);
  assert.match(scripts[0], /text fields of pathSheet/);
  assert.match(scripts[0], /locateImportPathField/);
  assert.match(scripts[0], /value of attribute "AXIdentifier"/);
  assert.match(scripts[0], /description of candidate/);
  assert.match(scripts[0], /FINAL_CUT_PUBLISH_PATH_CONTROL_AMBIGUOUS/);
  assert.equal(scripts[0].includes("set pathField to item 1 of pathFields"), false);
  assert.match(scripts[0], /waitForImportSheetDismissal/);
  assert.match(scripts[0], /on error/);
  assert.match(scripts[0], /Cancel/);
  assert.equal(scripts[0].includes("delay 0.4"), false);
  assert.match(scripts[0], /published project\.fcpxml/);
  await assert.rejects(readFile(result.importedPath), /ENOENT/);
});

test("FCPXML publisher rejects a stale active project with matching names", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-stale-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Shared Name"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const staleState = {
    project: { id: "old-project", name: "Shared Name" },
    sequence: { id: "old-sequence", name: "Main", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
    revision: { id: "rev-stale", sequence: 1, timestamp: new Date(0).toISOString() },
  };

  await assert.rejects(new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => "imported",
    liveState: async () => staleState,
  }).publishNewProject({
    sourceTransactionId: "txn-stale",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  }), /FINAL_CUT_PUBLISH_VERIFICATION_FAILED/);
});

test("FCPXML publisher requires live project and sequence verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-state-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  await assert.rejects(new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => "imported",
  }).publishNewProject({
    sourceTransactionId: "txn-no-state",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  }), /FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE/);
});

test("FCPXML publisher waits for the imported project identity to settle", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-poll-"));
  const sourcePath = join(directory, "project.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);
  const states = [
    { project: { id: "before-project", name: "Existing" }, sequence: { id: "before-sequence", name: "Existing" } },
    { project: { id: "before-project", name: "Existing" }, sequence: { id: "before-sequence", name: "Existing" } },
    { project: { id: "imported-project", name: "Published Edit" }, sequence: { id: "imported-sequence", name: "Main" } },
  ];
  let stateIndex = 0;

  const result = await new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    verificationTimeoutMs: 100,
    pollIntervalMs: 0,
    executor: async () => "imported",
    liveState: async () => {
      const state = states[Math.min(stateIndex++, states.length - 1)]!;
      return {
        ...state,
        sequence: {
          ...state.sequence,
          startTime: { value: "0", timescale: "1" },
          duration: { value: "1", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${stateIndex}`, sequence: stateIndex, timestamp: new Date(0).toISOString() },
      };
    },
  }).publishNewProject({
    sourceTransactionId: "txn-poll",
    artifactPath: sourcePath,
    artifactDigest: digest(source),
    confirm: true,
  });

  assert.equal(result.createdTarget.projectId, "imported-project");
  assert.equal(result.createdTarget.sequenceId, "imported-sequence");
  assert.equal(stateIndex, 3);
});

test("FCPXML publisher rejects invalid artifacts before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-invalid-"));
  const sourcePath = join(directory, "invalid.fcpxml");
  await writeFile(sourcePath, "not fcpxml");
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });
  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-invalid",
    artifactPath: sourcePath,
    artifactDigest: digest("not fcpxml"),
    confirm: true,
  }), /PUBLISH_VALIDATION_FAILED/);
  assert.equal(called, false);
});

test("FCPXML publisher requires explicit confirmation before automation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-confirmation-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-publish-2",
    artifactPath: sourcePath,
    artifactDigest: digest('<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>'),
    confirm: false,
  }), /PUBLISH_CONFIRMATION_REQUIRED/);
  assert.equal(called, false);
});

test("FCPXML publisher names the supported runtime configuration when disabled", async () => {
  const publisher = new FinalCutProjectPublisher({
    sourcePath: "/tmp/project.fcpxml",
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-disabled",
    artifactPath: "/tmp/project.fcpxml",
    artifactDigest: "unused",
    confirm: true,
  }), /FRAMEKIT_EDITOR.*FRAMEKIT_FCPXML_PATH.*FRAMEKIT_FINAL_CUT_SOCKET/);
});

test("FCPXML publisher rejects an artifact path outside its managed source", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-target-"));
  const sourcePath = join(directory, "project.fcpxml");
  await writeFile(sourcePath, '<fcpxml version="1.11"><library><event><project name="Published Edit"><sequence /></project></event></library></fcpxml>');
  let called = false;
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath,
    executor: async () => {
      called = true;
      return "";
    },
  });

  await assert.rejects(publisher.publishNewProject({
    sourceTransactionId: "txn-publish-3",
    artifactPath: join(directory, "other.fcpxml"),
    artifactDigest: "unused",
    confirm: true,
  }), /PUBLISH_TARGET_MISMATCH/);
  assert.equal(called, false);
});
