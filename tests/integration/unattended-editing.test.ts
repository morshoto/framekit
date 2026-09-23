import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  runUnattendedEditingWorkflow,
  type UnattendedEditingEnvironment,
} from "@framekit/final-cut";
import {
  parseFinalCutSqliteInspectionResponse,
  type FinalCutSqliteObservation,
} from "@framekit/final-cut";
import type { TimelineIr } from "@framekit/runtime";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "150", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [{
      id: "media-1",
      name: "opening.mov",
      mediaKind: "video",
      source: "/media/opening.mov",
    }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-14T00:00:00.000Z" },
  };
}

function changedProviderState(): TimelineIr {
  const value = timeline();
  value.sequence.occurrences[0]!.gainDb = -6;
  value.revision = { id: "revision-2", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" };
  return value;
}

function environment(overrides: Partial<UnattendedEditingEnvironment> = {}): UnattendedEditingEnvironment {
  return {
    process: "running",
    frontmost: "final-cut",
    console: { state: "locked", source: "IOConsoleLocked", retryable: false },
    library: { state: "observed", evidence: "filesystem" },
    log: { state: "not-collected", lineCount: 0 },
    ...overrides,
  };
}

async function sqliteObservation(digest: string): Promise<FinalCutSqliteObservation> {
  const fixture = await readFile("tests/fixtures/final-cut-sqlite-inspection.json", "utf8");
  const parsed = parseFinalCutSqliteInspectionResponse(fixture);
  assert.equal(parsed.status, "partial");
  return {
    ...parsed.payload,
    backend: "final-cut-sqlite-read-only",
    sourcePath: "fixture/CurrentVersion.fcpevent",
    databaseKind: "fcpevent",
    digest,
    revision: { id: digest, sequence: 102, timestamp: "2026-09-14T00:00:00.000Z" },
    canonical: false,
    coverage: {
      complete: false,
      projectIdentity: "partial",
      sequenceIdentity: "unknown",
      clipOccurrences: "unknown",
      mediaIdentity: "partial",
      rationalTiming: "unknown",
      roles: "unknown",
      storylineRelationships: "unknown",
      markersCaptions: "unknown",
      revision: "partial",
    },
  };
}

test("runs unattended edit, reconciliation, artifact compilation, and native classification without mutation", async () => {
  const before = await sqliteObservation("a".repeat(64));
  const after = await sqliteObservation("b".repeat(64));
  const result = runUnattendedEditingWorkflow({
    base: timeline(),
    providerState: changedProviderState(),
    operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Opening revised" }],
    target: { provider: "final-cut", libraryUid: "library-1", eventUid: "event-1", projectUid: "project-1", sequenceUid: "sequence-1" },
    environment: environment(),
    sqlite: { before, after },
  });

  assert.equal(result.status, "artifact-verified-native-blocked");
  assert.equal(result.session.state, "rebased");
  assert.equal(result.session.desired.sequence.occurrences[0]?.name, "Opening revised");
  assert.equal(result.session.desired.sequence.occurrences[0]?.gainDb, -6);
  assert.equal(result.reconciliation?.status, "rebased");
  assert.equal(result.sqlite.status, "changed");
  assert.equal(result.sqlite.canonical, false);
  assert.equal(result.artifact?.format, "fcpxml");
  assert.match(result.artifact?.xml ?? "", /<fcpxml version="1\.11">/);
  const experiment = result.experiment;
  assert.ok(experiment);
  assert.deepEqual(experiment.blockers[0], {
    code: "FINAL_CUT_NATIVE_CONSOLE_LOCKED",
    retryable: false,
    message: "The macOS console is locked; no headed FCPXML import was attempted",
  });
  assert.equal(experiment.mutationAttempted, false);
  assert.equal(experiment.nativeImportVerified, false);
  assert.equal(result.overwritten, false);
});

test("stops before FCPXML materialization when reconciliation has an explicit conflict", () => {
  const provider = changedProviderState();
  provider.sequence.occurrences[0]!.name = "Provider rename";
  const result = runUnattendedEditingWorkflow({
    base: timeline(),
    providerState: provider,
    operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Agent rename" }],
    target: { provider: "final-cut", libraryUid: "library-1", eventUid: "event-1", projectUid: "project-1", sequenceUid: "sequence-1" },
    environment: environment({ console: { state: "unlocked", source: "IOConsoleLocked", retryable: false } }),
  });

  assert.equal(result.status, "conflicted");
  assert.equal(result.artifact, undefined);
  assert.equal(result.session.state, "conflicted");
  assert.equal(result.experiment, undefined);
  assert.equal(result.overwritten, false);
});

test("stops before materialization when SQLite changes without a fresh provider revision", async () => {
  const before = await sqliteObservation("a".repeat(64));
  const after = await sqliteObservation("b".repeat(64));
  const result = runUnattendedEditingWorkflow({
    base: timeline(),
    providerState: timeline(),
    operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Opening revised" }],
    target: { provider: "final-cut", libraryUid: "library-1", eventUid: "event-1", projectUid: "project-1", sequenceUid: "sequence-1" },
    environment: environment({ console: { state: "unlocked", source: "IOConsoleLocked", retryable: false } }),
    sqlite: { before, after },
  });

  assert.equal(result.status, "stale");
  assert.equal(result.session.state, "possibly_stale");
  assert.equal(result.reconciliation, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.experiment, undefined);
  assert.equal(result.overwritten, false);
});

test("documents the unattended evidence boundaries", async () => {
  const documentation = await readFile("docs/architecture/unattended-editing.md", "utf8");

  assert.match(documentation, /SQLite observation -> Timeline IR session/);
  assert.match(documentation, /canonical: false/);
  assert.match(documentation, /nativeImportVerified: false/);
  assert.match(documentation, /mutationAttempted: false/);
  assert.match(documentation, /conflicted/);
});
