import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAMEKIT_PROJECT_SCHEMA_VERSION,
  InMemoryTransactionStore,
  PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
  ProjectTransactionService,
  type EditTransaction,
  type FramekitProjectDocument,
  type ProjectStore,
  type TransactionStore,
} from "@framekit/runtime";

function project(): FramekitProjectDocument {
  return {
    schemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION,
    metadata: {
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
    timeline: {
      schemaVersion: 1,
      project: { id: "project-port", name: "Storage ports" },
      sequence: {
        id: "sequence-port",
        name: "Master",
        durationTime: { value: "2", timescale: "1" },
        frameDuration: { value: "1", timescale: "30" },
        occurrences: [{
          id: "occurrence-port",
          name: "Original name",
          startTime: { value: "0", timescale: "1" },
          durationTime: { value: "2", timescale: "1" },
          track: 0,
        }],
        storyElements: [],
        markers: [],
        captions: [],
      },
      resources: [],
      revision: { id: "revision-port", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
    },
  };
}

class MemoryProjectStore implements ProjectStore {
  private current: FramekitProjectDocument;

  public constructor(initial: FramekitProjectDocument) {
    this.current = structuredClone(initial);
  }

  public async create(value: FramekitProjectDocument): Promise<FramekitProjectDocument> {
    this.current = structuredClone(value);
    return structuredClone(this.current);
  }

  public async load(): Promise<FramekitProjectDocument> {
    return structuredClone(this.current);
  }

  public async save(value: FramekitProjectDocument): Promise<FramekitProjectDocument> {
    this.current = structuredClone(value);
    return structuredClone(this.current);
  }
}

test("project transactions use an injected project store without filesystem access", async () => {
  const initial = project();
  const store = new MemoryProjectStore(initial);
  const service = new ProjectTransactionService(store, { clock: () => "2026-10-05T00:01:00.000Z" });

  const preview = await service.preview({
    schemaVersion: PROJECT_EDIT_COMMAND_SCHEMA_VERSION,
    target: { projectId: "project-port", sequenceId: "sequence-port" },
    expectedRevision: initial.timeline.revision,
    operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-port", name: "Preview name" }],
  });

  assert.equal(preview.after.timeline.sequence.occurrences[0]?.name, "Preview name");
  assert.deepEqual(await store.load(), initial);
});

test("transaction storage can be replaced through its narrow contract", () => {
  const transaction = { id: "txn-port" } as EditTransaction;
  const store: TransactionStore = {
    set(value) {
      assert.strictEqual(value, transaction);
    },
    get(transactionId) {
      assert.equal(transactionId, transaction.id);
      return transaction;
    },
  };

  store.set(transaction);
  assert.strictEqual(store.get("txn-port"), transaction);
});

test("the default transaction store retains set, get, and missing errors", () => {
  const transaction = { id: "txn-default" } as EditTransaction;
  const store = new InMemoryTransactionStore();

  store.set(transaction);
  assert.strictEqual(store.get("txn-default"), transaction);
  assert.throws(() => store.get("txn-missing"), /TRANSACTION_NOT_FOUND/);
});
