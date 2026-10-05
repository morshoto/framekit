import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRAMEKIT_PROJECT_SCHEMA_VERSION,
  FramekitProjectStore,
  PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
  ProjectTransactionService,
  type FramekitProjectDocument,
  type ProjectEditCommand,
  type TimelineIrEditOperation,
} from "@framekit/runtime";

function project(): FramekitProjectDocument {
  return {
    schemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION,
    metadata: { createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" },
    timeline: {
      schemaVersion: 1,
      project: { id: "project-transactions", name: "Transactions" },
      sequence: {
        id: "sequence-transactions",
        name: "Master",
        durationTime: { value: "2", timescale: "1" },
        frameDuration: { value: "1", timescale: "30" },
        occurrences: [{
          id: "occurrence-1",
          name: "Original name",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "2", timescale: "1" },
          track: 0,
          mediaId: "media-1",
        }],
        storyElements: [],
        markers: [],
        captions: [],
      },
      resources: [{
        id: "media-1",
        name: "Source",
        mediaKind: "video",
        metadata: {
          durationTime: { value: "10", timescale: "1" },
          streams: [{
            kind: "video",
            codec: "raw",
            width: 1920,
            height: 1080,
            frameRate: { value: "30", timescale: "1" },
          }],
        },
      }],
      revision: { id: "revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
    },
  };
}

function command(
  projectValue: FramekitProjectDocument,
  name: string,
  operations?: TimelineIrEditOperation[],
): ProjectEditCommand {
  return {
    schemaVersion: PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
    target: { projectId: projectValue.timeline.project.id, sequenceId: projectValue.timeline.sequence.id },
    expectedRevision: projectValue.timeline.revision,
    operations: operations ?? [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name }],
  };
}

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), "framekit-project-transactions-"));
  const store = new FramekitProjectStore(join(directory, "project.json"));
  const initial = project();
  await store.create(initial);
  return { directory, store, initial, service: new ProjectTransactionService(store, { clock: () => "2026-10-05T00:01:00.000Z" }) };
}

test("preview returns an exact diff without mutating persisted canonical state", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const preview = await service.preview(command(initial, "Preview name"));
    assert.deepEqual(preview.before.timeline, initial.timeline);
    assert.equal(preview.after.timeline.sequence.occurrences[0]?.name, "Preview name");
    assert.deepEqual(preview.changedOccurrenceIds, ["occurrence-1"]);
    assert.notEqual(preview.diff.beforeDigest, preview.diff.afterDigest);
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execute advances the project revision once and sequential commands use the new revision", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const first = await service.execute(command(initial, "First name"));
    assert.equal(first.after.timeline.revision.sequence, 1);
    assert.equal(first.after.timeline.sequence.occurrences[0]?.name, "First name");
    assert.equal(first.after.timeline.revision.timestamp, "2026-10-05T00:01:00.000Z");

    const second = await service.execute(command(first.after, "Second name"));
    assert.equal(second.after.timeline.revision.sequence, 2);
    assert.equal(second.after.timeline.sequence.occurrences[0]?.name, "Second name");
    assert.deepEqual((await store.load()).timeline.revision, second.after.timeline.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale revisions and invalid target identities fail before mutation", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute({ ...command(initial, "Stale"), expectedRevision: { ...initial.timeline.revision, sequence: 9 } }),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_STALE_REVISION",
    );
    await assert.rejects(
      service.execute({ ...command(initial, "Wrong target"), target: { ...command(initial, "Wrong target").target, projectId: "wrong-project" } }),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_TARGET_MISMATCH",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid operations fail before persistence and preserve the prior project", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute({ ...command(initial, "Invalid"), operations: [{ type: "rename-occurrence", occurrenceId: "missing", name: "Invalid" }] }),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inserts and appends occurrences with exact timing and canonical ordering", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const result = await service.execute(command(initial, "unused", [
      {
        type: "insert-occurrence",
        placement: "append",
        occurrence: {
          id: "occurrence-2",
          name: "Appended",
          startTime: { value: "999", timescale: "1" },
          durationTime: { value: "3", timescale: "2" },
          track: 0,
          mediaId: "media-1",
        },
      },
      {
        type: "insert-occurrence",
        occurrence: {
          id: "occurrence-0",
          name: "Earlier",
          startTime: { value: "1", timescale: "2" },
          durationTime: { value: "1", timescale: "2" },
          track: 0,
          mediaId: "media-1",
        },
      },
    ]));

    assert.deepEqual(result.after.timeline.sequence.occurrences.map(({ id, startTime }) => [id, startTime]), [
      ["occurrence-1", { value: "0", timescale: "1" }],
      ["occurrence-0", { value: "1", timescale: "2" }],
      ["occurrence-2", { value: "2", timescale: "1" }],
    ]);
    assert.deepEqual(result.after.timeline.sequence.durationTime, { value: "7", timescale: "2" });
    assert.deepEqual((await store.load()).timeline.sequence.occurrences, result.after.timeline.sequence.occurrences);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trims source start and duration without losing exact rational timing", async () => {
  const { directory, initial, service } = await createService();
  try {
    const result = await service.execute(command(initial, "unused", [{
      type: "trim-occurrence",
      occurrenceId: "occurrence-1",
      sourceStartTime: { value: "1", timescale: "3" },
      durationTime: { value: "5", timescale: "6" },
    }]));
    const occurrence = result.after.timeline.sequence.occurrences[0]!;
    assert.deepEqual(occurrence.sourceStartTime, { value: "1", timescale: "3" });
    assert.deepEqual(occurrence.durationTime, { value: "5", timescale: "6" });
    assert.deepEqual(result.after.timeline.sequence.durationTime, { value: "2", timescale: "1" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("splits an occurrence into stable left and right identities", async () => {
  const { directory, initial, service } = await createService();
  try {
    const result = await service.execute(command(initial, "unused", [{
      type: "split-occurrence",
      occurrenceId: "occurrence-1",
      splitOffsetTime: { value: "1", timescale: "2" },
      newOccurrenceId: "occurrence-1-right",
    }]));
    assert.deepEqual(result.after.timeline.sequence.occurrences, [
      {
        id: "occurrence-1",
        name: "Original name",
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "1", timescale: "2" },
        track: 0,
        mediaId: "media-1",
      },
      {
        id: "occurrence-1-right",
        name: "Original name",
        startTime: { value: "1", timescale: "2" },
        durationTime: { value: "3", timescale: "2" },
        sourceStartTime: { value: "1", timescale: "2" },
        track: 0,
        mediaId: "media-1",
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("moves and removes occurrences while preserving deterministic order", async () => {
  const { directory, initial, service } = await createService();
  try {
    const result = await service.execute(command(initial, "unused", [
      {
        type: "insert-occurrence",
        occurrence: {
          id: "occurrence-2",
          name: "Second",
          startTime: { value: "3", timescale: "1" },
          durationTime: { value: "1", timescale: "1" },
          track: 0,
          mediaId: "media-1",
        },
      },
      {
        type: "move-occurrence",
        occurrenceId: "occurrence-2",
        startTime: { value: "1", timescale: "2" },
        track: 1,
      },
      { type: "remove-occurrence", occurrenceId: "occurrence-1" },
    ]));
    assert.deepEqual(result.after.timeline.sequence.occurrences.map(({ id, startTime, track }) => ({ id, startTime, track })), [
      { id: "occurrence-2", startTime: { value: "1", timescale: "2" }, track: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid structural ranges without persisting a revision", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute(command(initial, "unused", [{
        type: "split-occurrence",
        occurrenceId: "occurrence-1",
        splitOffsetTime: { value: "2", timescale: "1" },
        newOccurrenceId: "invalid-right",
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
