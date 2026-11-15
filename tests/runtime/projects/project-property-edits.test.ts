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
      project: { id: "project-properties", name: "Properties" },
      sequence: {
        id: "sequence-properties",
        name: "Master",
        durationTime: { value: "2", timescale: "1" },
        frameDuration: { value: "1", timescale: "30" },
        occurrences: [{
          id: "occurrence-1",
          name: "Original",
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

function command(projectValue: FramekitProjectDocument, operations: TimelineIrEditOperation[]): ProjectEditCommand {
  return {
    schemaVersion: PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
    target: { projectId: projectValue.timeline.project.id, sequenceId: projectValue.timeline.sequence.id },
    expectedRevision: projectValue.timeline.revision,
    operations,
  };
}

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), "framekit-project-properties-"));
  const store = new FramekitProjectStore(join(directory, "project.json"));
  const initial = project();
  await store.create(initial);
  return { directory, store, initial, service: new ProjectTransactionService(store, { clock: () => "2026-10-05T00:01:00.000Z" }) };
}

test("previews and persists exact gain and transform properties", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const operations: TimelineIrEditOperation[] = [
      { type: "set-gain", occurrenceId: "occurrence-1", gainDb: 3.5 },
      {
        type: "set-transform",
        occurrenceId: "occurrence-1",
        transform: { scaleX: 1.25, scaleY: 0.75, positionX: 12, positionY: -8, rotationDegrees: 2.5 },
      },
    ];
    const preview = await service.preview(command(initial, operations));
    assert.equal(preview.after.timeline.sequence.occurrences[0]?.gainDb, 3.5);
    assert.deepEqual(preview.after.timeline.sequence.occurrences[0]?.transform, operations[1].type === "set-transform" ? operations[1].transform : undefined);
    assert.deepEqual(await store.load(), initial);

    const result = await service.execute(command(initial, operations));
    assert.equal(result.after.timeline.revision.sequence, 1);
    assert.equal(result.after.timeline.sequence.occurrences[0]?.gainDb, 3.5);
    assert.deepEqual(result.after.timeline.sequence.occurrences[0]?.transform, operations[1].type === "set-transform" ? operations[1].transform : undefined);
    assert.deepEqual((await store.load()).timeline.sequence.occurrences[0]?.transform, result.after.timeline.sequence.occurrences[0]?.transform);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported property requests fail explicitly without semantic loss", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const unsupported = { type: "set-opacity", occurrenceId: "occurrence-1", opacity: 0.5 } as never;
    await assert.rejects(
      service.execute(command(initial, [unsupported])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_UNSUPPORTED",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid transform values fail before persistence", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute(command(initial, [{
        type: "set-transform",
        occurrenceId: "occurrence-1",
        transform: { scaleX: 0, scaleY: 1 },
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown transform properties fail before persistence", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute(command(initial, [{
        type: "set-transform",
        occurrenceId: "occurrence-1",
        transform: { scaleX: 1, scaleY: 1, opacity: 0.5 } as never,
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
