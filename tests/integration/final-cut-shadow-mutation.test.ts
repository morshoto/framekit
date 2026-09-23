import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { FinalCutShadowBundleMutator } from "@framekit/final-cut";

const execFile = promisify(execFileCallback);

async function createBundle(root: string): Promise<{ bundle: string; database: string }> {
  const bundle = join(root, "Source.fcpbundle");
  const database = join(bundle, "Event", "CurrentVersion.fcpevent");
  await mkdir(join(bundle, "Event"), { recursive: true });
  await execFile("sqlite3", [database, "CREATE TABLE ZCOLLECTION (Z_PK INTEGER PRIMARY KEY, Z_OPT INTEGER NOT NULL, ZNAME TEXT NOT NULL); CREATE TABLE Z_MODELCACHE (Z_CONTENT BLOB); INSERT INTO Z_MODELCACHE VALUES (x'6d6f64656c'); INSERT INTO ZCOLLECTION VALUES (1, 1, 'Original');"]);
  return { bundle, database };
}

test("mutates an allowlisted collection only in a verified shadow bundle", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-shadow-mutation-"));
  try {
    const { bundle, database } = await createBundle(root);
    const shadowRoot = join(root, "shadows");
    const mutator = new FinalCutShadowBundleMutator({ shadowRoot });

    const shadow = await mutator.createShadow(bundle);
    const result = await mutator.renameCollection({ shadow, databaseRelativePath: "Event/CurrentVersion.fcpevent", collectionPrimaryKey: 1, expectedOptimisticVersion: 1, name: "Revised" });

    assert.notEqual(result.databasePath, database);
    assert.equal(result.integrity, "ok");
    assert.notEqual(result.beforeDigest, result.afterDigest);
    const { stdout: backup } = await execFile("sqlite3", [result.backupPath, "SELECT ZNAME || ':' || Z_OPT FROM ZCOLLECTION WHERE Z_PK = 1;"]);
    assert.equal(backup.trim(), "Original:1");
    const { stdout } = await execFile("sqlite3", [result.databasePath, "SELECT ZNAME || ':' || Z_OPT FROM ZCOLLECTION WHERE Z_PK = 1;"]);
    assert.equal(stdout.trim(), "Revised:2");
    const { stdout: source } = await execFile("sqlite3", [database, "SELECT ZNAME || ':' || Z_OPT FROM ZCOLLECTION WHERE Z_PK = 1;"]);
    assert.equal(source.trim(), "Original:1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a database path escapes its shadow bundle", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-shadow-mutation-"));
  try {
    const { bundle } = await createBundle(root);
    const mutator = new FinalCutShadowBundleMutator({ shadowRoot: join(root, "shadows") });
    const shadow = await mutator.createShadow(bundle);

    await assert.rejects(
      mutator.renameCollection({ shadow, databaseRelativePath: "../outside.fcpevent", collectionPrimaryKey: 1, expectedOptimisticVersion: 1, name: "Rejected" }),
      /FINAL_CUT_SHADOW_DATABASE_PATH_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails before mutation when the Core Data schema is unsupported", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-shadow-mutation-"));
  try {
    const bundle = join(root, "Source.fcpbundle");
    await mkdir(join(bundle, "Event"), { recursive: true });
    await writeFile(join(bundle, "Event", "CurrentVersion.fcpevent"), "not sqlite", "utf8");
    const mutator = new FinalCutShadowBundleMutator({ shadowRoot: join(root, "shadows") });
    const shadow = await mutator.createShadow(bundle);

    await assert.rejects(
      mutator.renameCollection({ shadow, databaseRelativePath: "Event/CurrentVersion.fcpevent", collectionPrimaryKey: 1, expectedOptimisticVersion: 1, name: "Rejected" }),
      /FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when the collection optimistic version changed before the shadow transaction", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-shadow-mutation-"));
  try {
    const { bundle } = await createBundle(root);
    const mutator = new FinalCutShadowBundleMutator({ shadowRoot: join(root, "shadows") });
    const shadow = await mutator.createShadow(bundle);

    await assert.rejects(
      mutator.renameCollection({ shadow, databaseRelativePath: "Event/CurrentVersion.fcpevent", collectionPrimaryKey: 1, expectedOptimisticVersion: 2, name: "Rejected" }),
      /FINAL_CUT_SHADOW_COLLECTION_NOT_FOUND/,
    );
    const { stdout } = await execFile("sqlite3", [join(shadow.shadowBundlePath, "Event", "CurrentVersion.fcpevent"), "SELECT ZNAME || ':' || Z_OPT FROM ZCOLLECTION WHERE Z_PK = 1;"]);
    assert.equal(stdout.trim(), "Original:1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executes a compiled recipe only when the exact schema fingerprint matches", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-shadow-mutation-"));
  try {
    const { bundle } = await createBundle(root);
    const mutator = new FinalCutShadowBundleMutator({ shadowRoot: join(root, "shadows") });
    const shadow = await mutator.createShadow(bundle);
    const expectedFingerprint = await mutator.fingerprintSchema(shadow, "Event/CurrentVersion.fcpevent");

    const result = await mutator.executeRecipe({
      shadow,
      databaseRelativePath: "Event/CurrentVersion.fcpevent",
      expectedFingerprint,
      recipe: { kind: "collection-rename-control", collectionPrimaryKey: 1, expectedOptimisticVersion: 1, name: "Compiled" },
    });
    assert.equal(result.integrity, "ok");
    await assert.rejects(
      mutator.executeRecipe({
        shadow,
        databaseRelativePath: "Event/CurrentVersion.fcpevent",
        expectedFingerprint,
        recipe: { kind: "collection-rename-control", collectionPrimaryKey: 1, expectedOptimisticVersion: 1, name: "Rejected" },
      }),
      /FINAL_CUT_SHADOW_COLLECTION_NOT_FOUND/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
