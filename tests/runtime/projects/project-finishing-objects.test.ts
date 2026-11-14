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
      project: { id: "project-finishing", name: "Finishing" },
      sequence: {
        id: "sequence-finishing",
        name: "Master",
        durationTime: { value: "2", timescale: "1" },
        frameDuration: { value: "1", timescale: "30" },
        occurrences: [
          {
            id: "occurrence-1",
            name: "First",
            startTime: { value: "0", timescale: "1" },
            durationTime: { value: "1", timescale: "1" },
            track: 0,
            mediaId: "media-1",
          },
          {
            id: "occurrence-2",
            name: "Second",
            startTime: { value: "1", timescale: "1" },
            durationTime: { value: "1", timescale: "1" },
            track: 0,
            mediaId: "media-1",
          },
        ],
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
  const directory = await mkdtemp(join(tmpdir(), "framekit-project-finishing-"));
  const store = new FramekitProjectStore(join(directory, "project.json"));
  const initial = project();
  await store.create(initial);
  return { directory, store, initial, service: new ProjectTransactionService(store, { clock: () => "2026-10-05T00:01:00.000Z" }) };
}

test("adds persistent opening and closing title overlays without moving source occurrences", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    const operations: TimelineIrEditOperation[] = [
      {
        type: "add-title",
        title: {
          id: "title-opening",
          text: "Opening",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
          style: { fontSize: 48, color: "#ffffff", alignment: "center" },
          position: { x: 0, y: -0.25 },
        },
      },
      {
        type: "add-title",
        title: {
          id: "title-closing",
          text: "Closing",
          startTime: { value: "2", timescale: "1" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
        },
      },
    ];
    const preview = await service.preview(command(initial, operations));
    assert.deepEqual(preview.after.timeline.sequence.occurrences, initial.timeline.sequence.occurrences);
    assert.deepEqual(preview.after.timeline.sequence.titles?.map(({ id }) => id), ["title-opening", "title-closing"]);
    assert.deepEqual(preview.changedTitleIds, ["title-opening", "title-closing"]);
    assert.deepEqual(await store.load(), initial);

    const result = await service.execute(command(initial, operations));
    assert.equal(result.after.timeline.revision.sequence, 1);
    assert.deepEqual((await store.load()).timeline.sequence.titles, result.after.timeline.sequence.titles);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing the last extending title recomputes sequence duration", async () => {
  const { directory, initial, service } = await createService();
  try {
    const added = await service.execute(command(initial, [
      {
        type: "add-title",
        title: {
          id: "title-extending",
          text: "Tail",
          startTime: { value: "2", timescale: "1" },
          durationTime: { value: "1", timescale: "2" },
          lane: 1,
        },
      },
    ]));
    assert.deepEqual(added.after.timeline.sequence.durationTime, { value: "5", timescale: "2" });
    const result = await service.execute(command(added.after, [{ type: "remove-title", titleId: "title-extending" }]));
    assert.deepEqual(result.after.timeline.sequence.durationTime, { value: "2", timescale: "1" });
    assert.deepEqual(result.after.timeline.sequence.titles, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds a cross-dissolve between exact adjacent occurrences", async () => {
  const { directory, initial, service } = await createService();
  try {
    const result = await service.execute(command(initial, [{
      type: "add-transition",
      transition: {
        id: "transition-1",
        kind: "cross-dissolve",
        beforeOccurrenceId: "occurrence-1",
        afterOccurrenceId: "occurrence-2",
        durationTime: { value: "1", timescale: "4" },
      },
    }]));
    assert.deepEqual(result.after.timeline.sequence.transitions, [{
      id: "transition-1",
      kind: "cross-dissolve",
      beforeOccurrenceId: "occurrence-1",
      afterOccurrenceId: "occurrence-2",
      durationTime: { value: "1", timescale: "4" },
    }]);
    assert.deepEqual(result.changedTransitionIds, ["transition-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checks transition adjacency within the participant track", async () => {
  const { directory, initial, service } = await createService();
  try {
    initial.timeline.sequence.occurrences.splice(1, 0, {
      id: "overlay-1",
      name: "Overlay",
      startTime: { value: "1", timescale: "2" },
      durationTime: { value: "1", timescale: "2" },
      track: 1,
      mediaId: "media-1",
    });
    const result = await service.execute(command(initial, [{
      type: "add-transition",
      transition: {
        id: "transition-interleaved",
        kind: "cross-dissolve",
        beforeOccurrenceId: "occurrence-1",
        afterOccurrenceId: "occurrence-2",
        durationTime: { value: "1", timescale: "4" },
      },
    }]));
    assert.equal(result.after.timeline.sequence.transitions?.[0]?.id, "transition-interleaved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid title and transition placement without persistence", async () => {
  const { directory, store, initial, service } = await createService();
  try {
    await assert.rejects(
      service.execute(command(initial, [{
        type: "add-title",
        title: {
          id: "invalid-title",
          text: "Invalid",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "1", timescale: "1" },
          lane: 0,
        },
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    await assert.rejects(
      service.execute(command(initial, [{
        type: "add-title",
        title: {
          id: "out-of-bounds-title",
          text: "Invalid position",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "1", timescale: "1" },
          lane: 1,
          position: { x: 1.01, y: 0 },
        },
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    await assert.rejects(
      service.execute(command(initial, [{
        type: "add-transition",
        transition: {
          id: "invalid-transition",
          kind: "cross-dissolve",
          beforeOccurrenceId: "occurrence-2",
          afterOccurrenceId: "occurrence-1",
          durationTime: { value: "1", timescale: "4" },
        },
      }])),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_EDIT_INVALID",
    );
    assert.deepEqual(await store.load(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
