import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_CUT_SQLITE_OPERATION_MATRIX,
  FINAL_CUT_SQLITE_WAL_BACKEND,
  FinalCutSqliteInspectionProvider,
  FinalCutSqliteWalObservationProvider,
  buildFinalCutSqliteInspectionQuery,
  diffFinalCutSqliteWalObservations,
} from "@framekit/final-cut";

const target = { projectId: "project-1", sequenceId: "sequence-1" };
const provenance = {
  framekitRevision: { id: "framekit-revision", sequence: 4, timestamp: "2026-10-07T00:00:00.000Z" },
  artifactDigest: "a".repeat(64),
  target,
};

const response = JSON.stringify({
  version: 1,
  schemaVersion: 18,
  userVersion: 0,
  tables: [],
  rowCounts: { ZCOLLECTION: 2, ZCOLLECTIONMD: 1 },
  collectionTypes: [{ type: "FFMediaEventProject", count: 1 }, { type: "FFAnchoredClip", count: 1 }],
  collectionRows: [
    { primaryKey: 1, type: "FFMediaEventProject", identifier: "project-1", optimisticVersion: 1 },
    { primaryKey: 2, type: "FFAnchoredClip", identifier: "clip-1", optimisticVersion: 1 },
  ],
  metadataRows: [{ primaryKey: 10, collectionId: 1, bytes: 32, archive: "NSKeyedArchiver" }],
});

function files(values: Record<string, string>) {
  const contents = new Map(Object.entries(values).map(([path, value]) => [path, Uint8Array.from(Buffer.from(value))]));
  return {
    readFile: async (path: string) => {
      const value = contents.get(path);
      if (value) return value;
      const error = new Error("missing file") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    },
    statFile: async (path: string) => {
      const value = contents.get(path);
      if (!value) {
        const error = new Error("missing file") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }
      return { size: value.byteLength, mtimeMs: 0 };
    },
  };
}

function provider(responseValue = response, digest = "db-before") {
  const inspectionProvider = new FinalCutSqliteInspectionProvider({
    executor: async () => responseValue,
    digest: async () => digest,
    timestamp: () => "2026-10-07T00:00:01.000Z",
  });
  return new FinalCutSqliteWalObservationProvider({
    inspectionProvider,
    ...files({
      "/tmp/project.db": "database-before",
      "/tmp/project.db-wal": "wal-before",
    }),
    timestamp: () => "2026-10-07T00:00:02.000Z",
  });
}

async function capture(digest = "db-before") {
  const result = await provider(response, digest).capture({
    databasePath: "/tmp/project.db",
    target,
    provenance,
    finalCutVersion: "10.7.1",
  });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") throw new Error("expected an observation");
  return result.observation;
}

test("read-only SQLite/WAL capture records storage evidence without canonical claims", async () => {
  const observation = await capture();

  assert.equal(observation.backend, FINAL_CUT_SQLITE_WAL_BACKEND);
  assert.equal(observation.canonical, false);
  assert.deepEqual(observation.target, target);
  assert.equal(observation.storage.database.present, true);
  assert.equal(observation.storage.wal.present, true);
  assert.equal(observation.storage.shm.present, false);
  assert.equal(observation.coverage.editorFreshness, "unknown");
  assert.equal(observation.coverage.canonicalTimeline, "unavailable");
});

test("SQLite inspection query is read-only and never foregrounds Final Cut", () => {
  const query = buildFinalCutSqliteInspectionQuery();

  assert.match(query, /PRAGMA query_only=ON/);
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE|DROP|ALTER/i);
  assert.doesNotMatch(query, /osascript|System Events|activate|frontmost/i);
});

test("before/after diff preserves row deltas and routes storage drift to canonical resync", async () => {
  const before = await capture("db-before");
  const after = structuredClone(before);
  after.database.revision = { id: "db-after", sequence: 2, timestamp: "2026-10-07T00:00:03.000Z" };
  after.database.collectionRows.push({ primaryKey: 3, type: "FFAsset", identifier: "asset-1", optimisticVersion: 1 });
  after.database.metadataRows[0]!.bytes = 64;
  after.storage.database.digest = "b".repeat(64);
  after.storage.wal.digest = "c".repeat(64);

  const delta = diffFinalCutSqliteWalObservations(before, after);

  assert.equal(delta.status, "changed");
  assert.equal(delta.collections.added[0]?.primaryKey, 3);
  assert.equal(delta.metadata.modified[0]?.after.bytes, 64);
  assert.equal(delta.storage.database, "changed");
  assert.equal(delta.storage.wal, "changed");
  assert.equal(delta.coverage.semanticOperation, "ambiguous");
  assert.equal(delta.recommendation, "canonical-resync-required");
});

test("target or Final Cut version drift is ambiguous and fails closed", async () => {
  const before = await capture();
  const current = structuredClone(before);
  current.target.projectId = "other-project";
  current.provenance.target.projectId = "other-project";
  current.finalCutVersion = "11.0.0";

  const delta = diffFinalCutSqliteWalObservations(before, current);

  assert.equal(delta.status, "ambiguous");
  assert.equal(delta.recommendation, "canonical-resync-required");
  assert.match(delta.reasons.join(" "), /target identity|Final Cut version/);
});

test("materialization provenance drift is ambiguous even when the target is unchanged", async () => {
  const before = await capture();
  const current = structuredClone(before);
  current.provenance.artifactDigest = "b".repeat(64);

  const delta = diffFinalCutSqliteWalObservations(before, current);

  assert.equal(delta.status, "ambiguous");
  assert.equal(delta.recommendation, "canonical-resync-required");
  assert.match(delta.reasons.join(" "), /provenance/);
});

test("operation matrix keeps unproven native mappings non-observable", () => {
  assert.equal(FINAL_CUT_SQLITE_OPERATION_MATRIX.length, 10);
  assert.equal(FINAL_CUT_SQLITE_OPERATION_MATRIX.every((entry) => entry.coverage === "not-observable"), true);
  assert.equal(FINAL_CUT_SQLITE_OPERATION_MATRIX.every((entry) => entry.canonical === false), true);
});

test("missing database returns structured unavailable state", async () => {
  const missing = new FinalCutSqliteWalObservationProvider({
    inspectionProvider: { inspect: async () => ({
      status: "unavailable" as const,
      error: { code: "FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE" as const, message: "missing", retryable: false },
    }) },
  });
  const result = await missing.capture({ databasePath: "/tmp/missing.db", target, provenance, finalCutVersion: "10.7.1" });

  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.error.code, "FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE");
});
