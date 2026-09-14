import assert from "node:assert/strict";
import test from "node:test";
import {
  EditingSession,
  reconcileTimelineIr,
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

test("merges non-overlapping edits on different occurrences deterministically", () => {
  const base = timeline();
  const ours = copy(base);
  ours.sequence.occurrences[0]!.name = "A edited by agent";
  const theirs = copy(base);
  theirs.sequence.occurrences[1]!.gainDb = -6;
  theirs.revision = { id: "provider-revision", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" };

  const result = reconcileTimelineIr({ base, ours, theirs });

  assert.equal(result.status, "rebased");
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged?.sequence.occurrences[0]?.name, "A edited by agent");
  assert.equal(result.merged?.sequence.occurrences[1]?.gainDb, -6);
  assert.equal(result.providerRevisionChanged, true);
});

test("merges distinct properties of the same occurrence but conflicts on the same property", () => {
  const base = timeline();
  const ours = copy(base);
  ours.sequence.occurrences[0]!.name = "A renamed";
  const theirs = copy(base);
  theirs.sequence.occurrences[0]!.gainDb = -3;

  const merged = reconcileTimelineIr({ base, ours, theirs });
  assert.equal(merged.status, "rebased");
  assert.equal(merged.merged?.sequence.occurrences[0]?.name, "A renamed");
  assert.equal(merged.merged?.sequence.occurrences[0]?.gainDb, -3);

  const conflicting = copy(base);
  conflicting.sequence.occurrences[0]!.name = "A provider rename";
  const conflict = reconcileTimelineIr({ base, ours, theirs: conflicting });
  assert.equal(conflict.status, "conflicted");
  assert.equal(conflict.merged, undefined);
  assert.equal(conflict.conflicts[0]?.kind, "property-conflict");
  assert.equal(conflict.conflicts[0]?.path, "sequence.occurrences[a].name");
});

test("surfaces delete-versus-modify and ambiguous insert conflicts", () => {
  const base = timeline();
  const ours = copy(base);
  ours.sequence.occurrences = ours.sequence.occurrences.filter(({ id }) => id !== "a");
  const theirs = copy(base);
  theirs.sequence.occurrences[0]!.durationTime = { value: "60", timescale: "30" };
  const deletedModified = reconcileTimelineIr({ base, ours, theirs });
  assert.equal(deletedModified.status, "conflicted");
  assert.equal(deletedModified.conflicts[0]?.kind, "delete-modify-conflict");

  const insertedByAgent = copy(base);
  insertedByAgent.sequence.occurrences.push({ id: "new", name: "Agent", startTime: { value: "180", timescale: "30" }, durationTime: { value: "30", timescale: "30" }, track: 0 });
  const insertedByProvider = copy(base);
  insertedByProvider.sequence.occurrences.push({ id: "new", name: "Provider", startTime: { value: "180", timescale: "30" }, durationTime: { value: "60", timescale: "30" }, track: 0 });
  const inserted = reconcileTimelineIr({ base, ours: insertedByAgent, theirs: insertedByProvider });
  assert.equal(inserted.status, "conflicted");
  assert.equal(inserted.conflicts[0]?.kind, "insert-conflict");
});

test("requires reconciliation after a provider revision changes and records state transitions", () => {
  const session = EditingSession.create({ base: timeline(), clock: () => "2026-09-14T00:03:00.000Z" });
  session.apply([{ type: "rename-occurrence", occurrenceId: "a", name: "A edited" }]);
  assert.equal(session.state(), "dirty");
  assert.throws(
    () => session.assertMaterializationReady({ id: "provider-revision", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" }),
    /RECONCILIATION_REQUIRED/,
  );
  assert.equal(session.state(), "possibly_stale");

  const providerState = timeline();
  providerState.sequence.occurrences[1]!.gainDb = -6;
  providerState.revision = { id: "provider-revision", sequence: 2, timestamp: "2026-09-14T00:02:00.000Z" };
  const result = session.reconcile(providerState);

  assert.equal(result.status, "rebased");
  assert.equal(session.state(), "rebased");
  assert.equal(session.desired().sequence.occurrences[0]?.name, "A edited");
  assert.equal(session.desired().sequence.occurrences[1]?.gainDb, -6);
  session.markClean();
  assert.equal(session.state(), "dirty");
  assert.doesNotThrow(() => session.assertMaterializationReady(providerState.revision));
});

test("turns ambiguous duplicate identities into explicit conflicts", () => {
  const base = timeline();
  const ours = copy(base);
  ours.sequence.occurrences.push(copy(base).sequence.occurrences[0]!);
  const result = reconcileTimelineIr({ base, ours, theirs: base });

  assert.equal(result.status, "conflicted");
  assert.equal(result.conflicts[0]?.kind, "ambiguous-identity");
});

test("keeps validation conflicts bound to the invalid entity", () => {
  const base = timeline();
  const malformed = copy(base);
  malformed.resources.push({ id: "resource-1", name: "", mediaKind: "video" });

  const invalid = reconcileTimelineIr({ base, ours: malformed, theirs: base });
  assert.equal(invalid.status, "conflicted");
  assert.equal(invalid.conflicts[0]?.kind, "invalid-state");
  assert.equal(invalid.conflicts[0]?.entity, "resource");
  assert.equal(invalid.conflicts[0]?.id, "resource-1");
  assert.equal(invalid.conflicts[0]?.path, "resources[resource-1].name");

  const duplicate = copy(base);
  duplicate.resources = [
    { id: "resource-1", name: "One", mediaKind: "video" },
    { id: "resource-1", name: "Two", mediaKind: "video" },
  ];
  const ambiguous = reconcileTimelineIr({ base, ours: duplicate, theirs: base });
  assert.equal(ambiguous.status, "conflicted");
  assert.equal(ambiguous.conflicts[0]?.kind, "ambiguous-identity");
  assert.equal(ambiguous.conflicts[0]?.entity, "resource");
  assert.equal(ambiguous.conflicts[0]?.id, "resource-1");
  assert.equal(ambiguous.conflicts[0]?.path, "resources");
});

test("surfaces invalid merged references as a structured conflict", () => {
  const base = timeline();
  base.resources = [
    { id: "resource-1", name: "One", mediaKind: "video" },
    { id: "resource-2", name: "Two", mediaKind: "video" },
  ];
  base.sequence.occurrences[0]!.mediaId = "resource-1";

  const ours = copy(base);
  ours.sequence.occurrences[0]!.mediaId = "resource-2";
  const theirs = copy(base);
  theirs.resources = theirs.resources.filter(({ id }) => id !== "resource-2");

  const result = reconcileTimelineIr({ base, ours, theirs });
  assert.equal(result.status, "conflicted");
  assert.equal(result.conflicts[0]?.kind, "invalid-state");
  assert.equal(result.conflicts[0]?.entity, "occurrence");
  assert.equal(result.conflicts[0]?.id, "a");
  assert.equal(result.conflicts[0]?.path, "sequence.occurrences[a].mediaId");
});

test("removing an occurrence preserves unrelated story elements with the same ID", () => {
  const base = timeline();
  base.sequence.storyElements = [{
    id: "a",
    kind: "title",
    startTime: { value: "0", timescale: "30" },
    durationTime: { value: "30", timescale: "30" },
  }];
  const session = EditingSession.create({ base });

  session.apply([{ type: "remove-occurrence", occurrenceId: "a" }]);

  assert.deepEqual(session.desired().sequence.storyElements, base.sequence.storyElements);
});
