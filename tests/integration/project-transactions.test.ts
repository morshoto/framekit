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
      resources: [{ id: "media-1", name: "Source", mediaKind: "video" }],
      revision: { id: "revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
    },
  };
}

function command(projectValue: FramekitProjectDocument, name: string): ProjectEditCommand {
  return {
    schemaVersion: PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
    target: { projectId: projectValue.timeline.project.id, sequenceId: projectValue.timeline.sequence.id },
    expectedRevision: projectValue.timeline.revision,
    operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name }],
  };
}

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), "framekit-project-transactions-"));
  const path = join(directory, "project.json");
  const store = new FramekitProjectStore(path);
  const initial = project();
  await store.create(initial);
  return { directory, path, store, initial, service: new ProjectTransactionService(store, { clock: () => "2026-10-05T00:01:00.000Z" }) };
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
    await assert.rejects(
      service.preview({ ...command(initial, "Unsupported"), operations: [{ type: "future-operation", occurrenceId: "occurrence-1" }] as unknown as ProjectEditCommand["operations"] }),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: string }).code === "PROJECT_EDIT_UNSUPPORTED"
        && /unsupported operation type/i.test(error.message),
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store stale errors are translated when a concurrent write wins after the guard", async () => {
  const { directory, path, initial } = await createService();
  try {
    class StaleOnSaveStore extends FramekitProjectStore {
      public override async save(next: FramekitProjectDocument, expectedRevision?: FramekitProjectDocument["timeline"]["revision"]) {
        const current = await super.load();
        const external = structuredClone(current);
        external.timeline.revision = { ...current.timeline.revision, id: "revision-external", sequence: current.timeline.revision.sequence + 1 };
        await super.save(external, current.timeline.revision);
        return super.save(next, expectedRevision);
      }
    }

    const raceStore = new StaleOnSaveStore(path);
    const service = new ProjectTransactionService(raceStore);
    await assert.rejects(service.execute(command(initial, "Race")), (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === "PROJECT_EDIT_STALE_REVISION"
      && /stale/i.test(error.message)
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
