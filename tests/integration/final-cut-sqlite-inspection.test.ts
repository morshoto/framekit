import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FINAL_CUT_SQLITE_INSPECTION_BACKEND,
  FinalCutSqliteInspectionProvider,
  buildFinalCutSqliteInspectionQuery,
  compareFinalCutSqliteObservations,
  parseFinalCutSqliteInspectionResponse,
} from "@framekit/final-cut";

const response = JSON.stringify({
  version: 1,
  schemaVersion: 18,
  userVersion: 0,
  tables: [
    {
      name: "ZCOLLECTION",
      sql: "CREATE TABLE ZCOLLECTION (Z_PK INTEGER PRIMARY KEY, Z_OPT INTEGER, ZIDENTIFIER VARCHAR, ZTYPE VARCHAR)",
      columns: [
        { name: "Z_PK", type: "INTEGER", primaryKey: 1 },
        { name: "Z_OPT", type: "INTEGER", primaryKey: 0 },
        { name: "ZIDENTIFIER", type: "VARCHAR", primaryKey: 0 },
        { name: "ZTYPE", type: "VARCHAR", primaryKey: 0 },
      ],
    },
    {
      name: "ZCOLLECTIONMD",
      sql: "CREATE TABLE ZCOLLECTIONMD (Z_PK INTEGER PRIMARY KEY, ZCOLLECTION INTEGER, ZDICTIONARYDATA BLOB)",
      columns: [
        { name: "Z_PK", type: "INTEGER", primaryKey: 1 },
        { name: "ZCOLLECTION", type: "INTEGER", primaryKey: 0 },
        { name: "ZDICTIONARYDATA", type: "BLOB", primaryKey: 0 },
      ],
    },
  ],
  rowCounts: { ZCOLLECTION: 3, ZCOLLECTIONMD: 2 },
  collectionTypes: [
    { type: "FFAnchoredClip", count: 1 },
    { type: "FFMediaEventProject", count: 1 },
  ],
  collectionRows: [
    { primaryKey: 4, type: "FFMediaEventProject", identifier: "project-1", optimisticVersion: 7, metadataId: 2 },
    { primaryKey: 8, type: "FFAnchoredClip", identifier: "clip-1", optimisticVersion: 3, metadataId: 9 },
  ],
  metadataRows: [
    { primaryKey: 2, collectionId: 4, bytes: 19282, archive: "NSKeyedArchiver" },
  ],
});

test("parses SQLite schema and reports incomplete canonical coverage", () => {
  const result = parseFinalCutSqliteInspectionResponse(response);

  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  assert.equal(result.payload.schemaVersion, 18);
  assert.equal(result.payload.tables[0]?.columns[0]?.name, "Z_PK");
  assert.equal(result.payload.rowCounts.ZCOLLECTION, 3);
  assert.equal(result.payload.metadataRows[0]?.archive, "NSKeyedArchiver");
  assert.ok(result.issues.some((issue) => issue.code === "FINAL_CUT_SQLITE_OPAQUE_PAYLOAD"));
});

test("parses the captured Final Cut 10.7.1 SQLite fixture deterministically", async () => {
  const captured = await readFile(new URL("../fixtures/final-cut-sqlite-inspection.json", import.meta.url), "utf8");
  const result = parseFinalCutSqliteInspectionResponse(captured);

  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  assert.deepEqual(result.payload.rowCounts, {
    ZCATALOGROOT: 1,
    ZCATALOGROOTMD: 1,
    ZCOLLECTION: 6661,
    ZCOLLECTIONMD: 2727,
    Z_3CHILDCOLLECTIONS: 8172,
    Z_METADATA: 1,
    Z_MODELCACHE: 1,
    Z_PRIMARYKEY: 4,
  });
  assert.equal(result.payload.metadataRows[0]?.archive, "NSKeyedArchiver");
});

test("rejects malformed SQLite inspection responses without guessing state", () => {
  const result = parseFinalCutSqliteInspectionResponse(JSON.stringify({ version: 1, tables: [] }));

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.error.code, "FINAL_CUT_SQLITE_RESPONSE_INVALID");
  assert.match(result.error.message, /schemaVersion/);
});

test("runs SQLite inspection as a read-only, non-UI query", () => {
  const query = buildFinalCutSqliteInspectionQuery();

  assert.match(query, /PRAGMA query_only=ON/);
  assert.match(query, /sqlite_master/);
  assert.match(query, /ZCOLLECTION/);
  assert.match(query, /ZDICTIONARYDATA/);
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE|DROP|ALTER/i);
  assert.doesNotMatch(query, /System Events|osascript|activate|frontmost/i);
});

test("creates a source-bound observation and detects storage drift", async () => {
  let digest = "digest-before";
  const provider = new FinalCutSqliteInspectionProvider({
    executor: async () => response,
    digest: async () => digest,
    timestamp: () => "2026-09-14T00:00:00.000Z",
  });

  const before = await provider.inspect("/tmp/CurrentVersion.fcpevent");
  assert.equal(before.status, "partial");
  if (before.status !== "partial") return;
  assert.equal(before.observation.backend, FINAL_CUT_SQLITE_INSPECTION_BACKEND);
  assert.equal(before.observation.canonical, false);
  assert.equal(before.observation.databaseKind, "fcpevent");
  assert.equal(before.observation.revision.id, "digest-before");
  assert.equal(before.observation.coverage.clipOccurrences, "unknown");

  digest = "digest-after";
  const after = await provider.inspect("/tmp/CurrentVersion.fcpevent");
  assert.equal(after.status, "partial");
  if (after.status !== "partial") return;
  assert.deepEqual(compareFinalCutSqliteObservations(before.observation, after.observation), {
    status: "changed",
    previousDigest: "digest-before",
    currentDigest: "digest-after",
    reasons: ["SQLite file digest changed"],
  });
});

test("returns structured unavailable state when sqlite cannot be queried", async () => {
  const provider = new FinalCutSqliteInspectionProvider({
    executor: async () => {
      throw new Error("database is locked");
    },
    digest: async () => "digest",
  });

  const result = await provider.inspect("/tmp/CurrentVersion.fcpevent");

  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.error.code, "FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE");
  assert.equal(result.error.retryable, true);
});
