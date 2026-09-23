import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertFinalCutSchemaFingerprint,
  buildFinalCutSchemaFingerprint,
  buildFinalCutGroundTruthSnapshotQuery,
  compileFinalCutShadowRecipe,
  createFinalCutGroundTruthCapture,
  decodeFinalCutKeyedArchive,
  diffFinalCutGroundTruthSnapshots,
  FinalCutGroundTruthCollector,
  parseFinalCutKeyedArchive,
  parseFinalCutGroundTruthSnapshotResponse,
  validateFinalCutGroundTruthCorpus,
} from "@framekit/final-cut";

const fingerprint = buildFinalCutSchemaFingerprint({
  schemaVersion: 18,
  tables: [
    { name: "ZCOLLECTION", sql: "CREATE TABLE ZCOLLECTION (Z_PK INTEGER PRIMARY KEY, Z_OPT INTEGER)" },
    { name: "ZCOLLECTIONMD", sql: "CREATE TABLE ZCOLLECTIONMD (Z_PK INTEGER PRIMARY KEY, ZDICTIONARYDATA BLOB)" },
  ],
  modelCache: Buffer.from("model-cache"),
});

test("fingerprints the exact Core Data schema and fails closed on drift", () => {
  assert.equal(fingerprint.schemaVersion, 18);
  assert.match(fingerprint.sqliteMasterDigest, /^[a-f0-9]{64}$/);
  assert.match(fingerprint.modelCacheDigest, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertFinalCutSchemaFingerprint(fingerprint, fingerprint));
  assert.throws(
    () => assertFinalCutSchemaFingerprint(fingerprint, { ...fingerprint, modelCacheDigest: "0".repeat(64) }),
    /FINAL_CUT_SHADOW_SCHEMA_FINGERPRINT_MISMATCH/,
  );
});

test("parses archive references and produces a semantic row, edge, and archive diff", () => {
  const before = snapshot({
    collection: { primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 2, name: "Before", metadataId: 8 },
    archive: archive("Before", 10),
    relationships: [{ parentPrimaryKey: 10, childPrimaryKey: 16 }],
  });
  const after = snapshot({
    collection: { primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 3, name: "After", metadataId: 8 },
    archive: archive("After", 11),
    relationships: [{ parentPrimaryKey: 10, childPrimaryKey: 16 }, { parentPrimaryKey: 16, childPrimaryKey: 27 }],
  });

  const parsed = parseFinalCutKeyedArchive(after.metadata[0]!.archive);
  assert.deepEqual(parsed.references, [{ fromObject: 0, path: "$.projectData", toObject: 11 }]);

  const diff = diffFinalCutGroundTruthSnapshots(before, after);
  assert.deepEqual(diff.collectionChanges, [{
    primaryKey: 10,
    type: "FFMediaEventProject",
    changed: ["name", "optimisticVersion"],
  }]);
  assert.deepEqual(diff.relationshipChanges.added, [{ parentPrimaryKey: 16, childPrimaryKey: 27 }]);
  assert.deepEqual(diff.archiveChanges, [{
    metadataPrimaryKey: 8,
    changed: ["$.$objects[0].displayName", "$.$objects[0].projectData.CF$UID"],
  }]);
});

test("decodes only binary keyed archives and never treats their fields as a writer contract", async () => {
  const source = archive("Candidate", 1);
  const decoded = await decodeFinalCutKeyedArchive(Buffer.from("bplist00fixture"), async () => source);
  assert.equal(decoded.archiver, "NSKeyedArchiver");
  await assert.rejects(
    decodeFinalCutKeyedArchive(Buffer.from("not-a-plist"), async () => source),
    /FINAL_CUT_SHADOW_ARCHIVE_UNSUPPORTED/,
  );
});

test("collects a read-only UI before/after snapshot with decoded archive evidence", async () => {
  const archiveValue = archive("Before", 10);
  const archiveBytes = Buffer.from("bplist00fixture");
  const response = JSON.stringify({
    schemaVersion: 18,
    tables: [
      { name: "ZCOLLECTION", sql: "CREATE TABLE ZCOLLECTION (Z_PK INTEGER PRIMARY KEY, Z_OPT INTEGER)" },
      { name: "ZCOLLECTIONMD", sql: "CREATE TABLE ZCOLLECTIONMD (Z_PK INTEGER PRIMARY KEY, ZDICTIONARYDATA BLOB)" },
    ],
    modelCacheHex: Buffer.from("model-cache").toString("hex"),
    collections: [{ primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 2, name: "Before", identifier: null, metadataId: 8 }],
    metadata: [{ primaryKey: 8, collectionPrimaryKey: 10, optimisticVersion: 1, archiveHex: archiveBytes.toString("hex") }],
    relationships: [{ parentPrimaryKey: 10, childPrimaryKey: 16 }],
  });
  const decoder = async () => archiveValue;
  const snapshotValue = await parseFinalCutGroundTruthSnapshotResponse(response, decoder);
  assert.deepEqual(snapshotValue, snapshot({
    collection: { primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 2, name: "Before", metadataId: 8 },
    archive: parseFinalCutKeyedArchive(archiveValue),
    archiveDigest: createHash("sha256").update(archiveBytes).digest("hex"),
    relationships: [{ parentPrimaryKey: 10, childPrimaryKey: 16 }],
  }));
  const collector = new FinalCutGroundTruthCollector({ executor: async (_path, query) => {
    assert.match(query, /PRAGMA query_only=ON/);
    return response;
  }, archiveDecoder: decoder });
  assert.deepEqual(await collector.collect("/disposable/CurrentVersion.fcpevent"), snapshotValue);
  assert.match(buildFinalCutGroundTruthSnapshotQuery(), /Z_3CHILDCOLLECTIONS/);
  assert.deepEqual(createFinalCutGroundTruthCapture("rename-1", "project-rename", snapshotValue, {
    ...snapshotValue,
    collections: [{ ...snapshotValue.collections[0]!, name: "After", optimisticVersion: 3 }],
  }), {
    id: "rename-1",
    operation: "project-rename",
    before: snapshotValue,
    after: {
      ...snapshotValue,
      collections: [{ ...snapshotValue.collections[0]!, name: "After", optimisticVersion: 3 }],
    },
    nativeEvidence: "unverified",
  });
});

test("requires a fingerprint-matched, single-operation ground-truth corpus before compiling a recipe", () => {
  const corpus = {
    schemaVersion: 1 as const,
    fingerprint,
    captures: [{
      id: "project-rename-1",
      operation: "project-rename" as const,
      before: snapshot({ collection: { primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 2, name: "Before", metadataId: 8 }, archive: archive("Before", 10), relationships: [] }),
      after: snapshot({ collection: { primaryKey: 10, type: "FFMediaEventProject", optimisticVersion: 3, name: "After", metadataId: 8 }, archive: archive("After", 10), relationships: [] }),
      nativeEvidence: "unverified" as const,
    }],
  };
  assert.doesNotThrow(() => validateFinalCutGroundTruthCorpus(corpus, fingerprint));
  assert.deepEqual(compileFinalCutShadowRecipe(corpus, fingerprint, {
    kind: "collection-rename-control",
    captureId: "project-rename-1",
    collectionPrimaryKey: 10,
    expectedOptimisticVersion: 2,
    name: "Candidate",
  }), {
    kind: "collection-rename-control",
    collectionPrimaryKey: 10,
    expectedOptimisticVersion: 2,
    name: "Candidate",
  });
  assert.throws(
    () => compileFinalCutShadowRecipe(corpus, fingerprint, {
      kind: "versioned-project-materialization",
      captureId: "project-rename-1",
      projectName: "Candidate",
      sequenceName: "Candidate",
    }),
    /FINAL_CUT_SHADOW_RECIPE_UNPROVEN/,
  );
});

function snapshot(input: {
  collection: { primaryKey: number; type: string; optimisticVersion: number; name: string; metadataId: number };
  archive: unknown;
  archiveDigest?: string;
  relationships: { parentPrimaryKey: number; childPrimaryKey: number }[];
}) {
  return {
    fingerprint,
    collections: [input.collection],
    metadata: [{
      primaryKey: input.collection.metadataId,
      collectionPrimaryKey: input.collection.primaryKey,
      optimisticVersion: 1,
      archive: input.archive,
      ...(input.archiveDigest ? { archiveDigest: input.archiveDigest } : {}),
    }],
    relationships: input.relationships,
  };
}

function archive(displayName: string, projectDataUid: number) {
  return {
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $top: { root: { "CF$UID": 0 } },
    $objects: [
      { displayName, projectData: { "CF$UID": projectDataUid } },
      ...Array.from({ length: 16 }, () => "$null"),
    ],
  };
}
