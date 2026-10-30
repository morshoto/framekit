import assert from "node:assert/strict";
import test from "node:test";
import {
  EditingSession,
  normalizeFastTimelineObservation,
  reconcileFastTimelineObservation,
  timelineIrDigest,
  type FastTimelineObservation,
  type TimelineIr,
} from "@framekit/runtime";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [
        { id: "a", name: "A", startTime: { value: "0", timescale: "30" }, durationTime: { value: "90", timescale: "30" }, track: 0, role: "video" },
        { id: "b", name: "B", startTime: { value: "90", timescale: "30" }, durationTime: { value: "90", timescale: "30" }, track: 0, role: "video" },
      ],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [],
    revision: { id: "base-revision", sequence: 1, timestamp: "2026-09-14T00:00:00.000Z" },
  };
}

function copy(value: TimelineIr): TimelineIr {
  return structuredClone(value);
}

function observation(value: TimelineIr, overrides: Partial<FastTimelineObservation> = {}): FastTimelineObservation {
  const target = { projectId: value.project.id, sequenceId: value.sequence.id };
  return {
    schemaVersion: 1,
    provider: "final-cut",
    sourceType: "pasteboard-fixture",
    canonical: false,
    target,
    provenance: {
      framekitRevision: { id: "materialized", sequence: 1, timestamp: "2026-09-14T00:00:00.000Z" },
      artifactDigest: "a".repeat(64),
      target,
    },
    observedAt: "2026-09-14T00:04:00.000Z",
    trust: "normalized",
    freshness: "editor-read",
    revision: value.revision,
    observationDigest: "b".repeat(64),
    timelineDigest: timelineIrDigest(value),
    coverage: completeCoverage(),
    unknowns: [],
    timeline: value,
    ...overrides,
  };
}

function completeCoverage(): FastTimelineObservation["coverage"] {
  return {
    occurrences: "complete",
    resources: "complete",
    timing: "complete",
    roles: "complete",
    storylineRelationships: "complete",
    markersCaptions: "complete",
  };
}

function session(base = timeline()): EditingSession {
  return EditingSession.create({
    base,
    provider: { id: "final-cut" },
    clock: () => "2026-09-14T00:03:00.000Z",
  });
}

test("normalization creates a validated envelope and computes a missing timeline digest", () => {
  const value = observation(timeline());
  delete value.timelineDigest;

  const normalized = normalizeFastTimelineObservation(value);

  assert.equal(normalized.timelineDigest, timelineIrDigest(value.timeline!));
  assert.deepEqual(normalized.provenance.target, value.target);
  assert.equal(normalized.canonical, false);
});

test("reconciles unchanged evidence through the EditingSession state", () => {
  const editing = session();
  const result = reconcileFastTimelineObservation({ session: editing, observation: observation(editing.base()) });

  assert.equal(result.status, "unchanged");
  assert.equal(result.session.state, "clean");
  assert.equal(editing.state(), "clean");
});

test("reconciles expected Framekit advancement and returns session evidence", () => {
  const editing = session();
  editing.apply([{ type: "rename-occurrence", occurrenceId: "a", name: "A edited" }]);

  const result = reconcileFastTimelineObservation({ session: editing, observation: observation(editing.desired()) });

  assert.equal(result.status, "advanced-by-framekit");
  assert.equal(result.reconciliation?.status, "rebased");
  assert.equal(result.session.desired.sequence.occurrences[0]?.name, "A edited");
  assert.equal(result.session.state, "rebased");
});

test("advances a complete normalized external structural delta only through EditingSession", () => {
  const editing = session();
  const external = copy(editing.base());
  external.sequence.occurrences[1]!.gainDb = -6;
  external.revision = { id: "provider-revision", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" };

  const result = reconcileFastTimelineObservation({ session: editing, observation: observation(external) });

  assert.equal(result.status, "proven-structural-delta");
  assert.equal(result.session.base.sequence.occurrences[1]?.gainDb, -6);
  assert.equal(editing.state(), "rebased");
});

test("blocks partial and storage-only evidence without replacing canonical fields", () => {
  const editing = session();
  const result = reconcileFastTimelineObservation({
    session: editing,
    observation: observation(editing.base(), {
      sourceType: "sqlite-wal",
      trust: "structural",
      freshness: "storage-observed",
      timeline: undefined,
      timelineDigest: undefined,
      coverage: { ...completeCoverage(), occurrences: "partial" },
      unknowns: ["timeline.semanticOperation"],
    }),
  });

  assert.equal(result.status, "possibly-stale");
  assert.equal(result.session.state, "possibly_stale");
  assert.equal(result.session.base.sequence.occurrences[0]?.name, "A");
  assert.equal(editing.state(), "possibly_stale");
});

test("fails closed for target mismatch and provider incompatibility", () => {
  const wrongTarget = session();
  const targetObservation = observation(wrongTarget.base(), {
    target: { projectId: "other", sequenceId: "sequence-1" },
    provenance: {
      ...observation(wrongTarget.base()).provenance,
      target: { projectId: "other", sequenceId: "sequence-1" },
    },
  });
  const targetResult = reconcileFastTimelineObservation({ session: wrongTarget, observation: targetObservation });
  assert.equal(targetResult.status, "target-mismatch");
  assert.equal(wrongTarget.state(), "conflicted");

  const wrongProvider = session();
  const providerResult = reconcileFastTimelineObservation({
    session: wrongProvider,
    observation: observation(wrongProvider.base(), { provider: "other-editor" }),
  });
  assert.equal(providerResult.status, "provider-incompatible");
  assert.equal(wrongProvider.state(), "conflicted");
});

test("rejects contradictory timeline digest and revision provenance", () => {
  const digestSession = session();
  const digestResult = reconcileFastTimelineObservation({
    session: digestSession,
    observation: observation(digestSession.base(), { timelineDigest: "c".repeat(64) }),
  });
  assert.equal(digestResult.status, "canonical-resync-required");
  assert.equal(digestSession.state(), "conflicted");

  const revisionSession = session();
  const revisionResult = reconcileFastTimelineObservation({
    session: revisionSession,
    observation: observation(revisionSession.base(), {
      revision: { id: "declared", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" },
    }),
  });
  assert.equal(revisionResult.status, "canonical-resync-required");
  assert.match(revisionResult.reason, /revision/);
});

test("surfaces three-way conflicts without promoting non-canonical evidence", () => {
  const editing = session();
  editing.apply([{ type: "rename-occurrence", occurrenceId: "a", name: "Agent rename" }]);
  const provider = copy(editing.base());
  provider.sequence.occurrences[0]!.name = "Provider rename";
  provider.revision = { id: "provider-revision", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" };

  const result = reconcileFastTimelineObservation({ session: editing, observation: observation(provider) });

  assert.equal(result.status, "conflicted");
  assert.equal(result.canonical, false);
  assert.equal(editing.state(), "conflicted");
  assert.equal(result.reconciliation?.conflicts[0]?.kind, "property-conflict");
});
