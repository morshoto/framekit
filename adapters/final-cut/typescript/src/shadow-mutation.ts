import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, cp, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertFinalCutSchemaFingerprint,
  buildFinalCutSchemaFingerprint,
  type FinalCutSchemaFingerprint,
  type FinalCutShadowRecipe,
} from "./sqlite-experiment.js";

const execFile = promisify(execFileCallback);

export interface FinalCutShadowBundle {
  sourceBundlePath: string;
  shadowBundlePath: string;
  sourceDigest: string;
}

export interface FinalCutShadowBundleMutatorOptions {
  shadowRoot: string;
  sqliteCommand?: string;
}

export interface RenameFinalCutShadowCollectionRequest {
  shadow: FinalCutShadowBundle;
  databaseRelativePath: string;
  collectionPrimaryKey: number;
  expectedOptimisticVersion: number;
  name: string;
}

export interface FinalCutShadowMutationResult {
  databasePath: string;
  backupPath: string;
  beforeDigest: string;
  afterDigest: string;
  integrity: "ok";
}

export interface ExecuteFinalCutShadowRecipeRequest {
  shadow: FinalCutShadowBundle;
  databaseRelativePath: string;
  expectedFingerprint: FinalCutSchemaFingerprint;
  recipe: FinalCutShadowRecipe;
}

/**
 * Experimental writer for disposable shadow copies only. It intentionally has
 * no API for timeline payloads, metadata BLOBs, or arbitrary SQL.
 */
export class FinalCutShadowBundleMutator {
  private readonly sqliteCommand: string;

  public constructor(private readonly options: FinalCutShadowBundleMutatorOptions) {
    this.sqliteCommand = options.sqliteCommand ?? "sqlite3";
  }

  public async createShadow(sourceBundlePath: string): Promise<FinalCutShadowBundle> {
    if (!sourceBundlePath.endsWith(".fcpbundle")) {
      throw new Error("FINAL_CUT_SHADOW_SOURCE_INVALID: source must be a .fcpbundle directory");
    }
    const sourceBundle = await realpath(sourceBundlePath);
    await mkdir(this.options.shadowRoot, { recursive: true });
    const shadowRoot = await realpath(this.options.shadowRoot);
    const shadowBundle = join(shadowRoot, `${basename(sourceBundle, ".fcpbundle")}-framekit-shadow-${randomUUID()}.fcpbundle`);
    await cp(sourceBundle, shadowBundle, { recursive: true, force: false, errorOnExist: true, dereference: false });
    const resolvedShadowBundle = await realpath(shadowBundle);
    if (!isWithin(shadowRoot, resolvedShadowBundle)) {
      throw new Error("FINAL_CUT_SHADOW_BUNDLE_PATH_INVALID: shadow bundle escaped the configured shadow root");
    }
    return {
      sourceBundlePath: sourceBundle,
      shadowBundlePath: resolvedShadowBundle,
      sourceDigest: await digestPath(sourceBundle),
    };
  }

  public async renameCollection(request: RenameFinalCutShadowCollectionRequest): Promise<FinalCutShadowMutationResult> {
    if (!Number.isSafeInteger(request.collectionPrimaryKey) || request.collectionPrimaryKey < 1) {
      throw new Error("FINAL_CUT_SHADOW_COLLECTION_INVALID: collectionPrimaryKey must be a positive integer");
    }
    if (!Number.isSafeInteger(request.expectedOptimisticVersion) || request.expectedOptimisticVersion < 1) {
      throw new Error("FINAL_CUT_SHADOW_COLLECTION_INVALID: expectedOptimisticVersion must be a positive integer");
    }
    if (request.name.length === 0 || request.name.includes("\0")) {
      throw new Error("FINAL_CUT_SHADOW_COLLECTION_INVALID: name must be non-empty text");
    }
    const databasePath = await this.resolveShadowDatabase(request.shadow, request.databaseRelativePath);
    await this.assertRenameSchema(databasePath);
    const beforeDigest = await digestPath(databasePath);
    const backupPath = `${databasePath}.framekit-backup-${randomUUID()}`;
    await copyFile(databasePath, backupPath);
    try {
      const name = request.name.replaceAll("'", "''");
      const sql = [
        "BEGIN IMMEDIATE;",
        `UPDATE ZCOLLECTION SET ZNAME = '${name}', Z_OPT = Z_OPT + 1 WHERE Z_PK = ${request.collectionPrimaryKey} AND Z_OPT = ${request.expectedOptimisticVersion};`,
        "SELECT changes();",
        "COMMIT;",
      ].join(" ");
      const { stdout } = await this.run(databasePath, sql);
      if (stdout.trim().split(/\s+/).at(-1) !== "1") {
        throw new Error("FINAL_CUT_SHADOW_COLLECTION_NOT_FOUND: collection was not updated");
      }
      const integrity = (await this.run(databasePath, "PRAGMA integrity_check;")).stdout.trim();
      if (integrity !== "ok") {
        throw new Error("FINAL_CUT_SHADOW_INTEGRITY_FAILED: SQLite integrity check failed after mutation");
      }
      return { databasePath, backupPath, beforeDigest, afterDigest: await digestPath(databasePath), integrity: "ok" };
    } catch (error) {
      // A committed but unverifiable shadow must never be left as a candidate.
      await copyFile(backupPath, databasePath);
      throw error;
    }
  }

  /**
   * Executes the sole compiler-produced recipe after proving the exact Core
   * Data schema/model cache. This is deliberately not an arbitrary-SQL API.
   */
  public async executeRecipe(request: ExecuteFinalCutShadowRecipeRequest): Promise<FinalCutShadowMutationResult> {
    const actualFingerprint = await this.fingerprintSchema(request.shadow, request.databaseRelativePath);
    assertFinalCutSchemaFingerprint(request.expectedFingerprint, actualFingerprint);
    return this.renameCollection({
      shadow: request.shadow,
      databaseRelativePath: request.databaseRelativePath,
      collectionPrimaryKey: request.recipe.collectionPrimaryKey,
      expectedOptimisticVersion: request.recipe.expectedOptimisticVersion,
      name: request.recipe.name,
    });
  }

  /** Read-only exact schema/model fingerprint for a recipe/corpus compatibility gate. */
  public async fingerprintSchema(shadow: FinalCutShadowBundle, databaseRelativePath: string): Promise<FinalCutSchemaFingerprint> {
    const databasePath = await this.resolveShadowDatabase(shadow, databaseRelativePath);
    const { stdout } = await this.run(databasePath, "PRAGMA query_only=ON; SELECT json_object('schemaVersion', (SELECT schema_version FROM pragma_schema_version), 'tables', (SELECT json_group_array(json_object('name', name, 'sql', sql)) FROM (SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name)), 'modelCacheHex', (SELECT hex(Z_CONTENT) FROM Z_MODELCACHE LIMIT 1));");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: could not read schema fingerprint");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: invalid schema fingerprint");
    const record = parsed as { schemaVersion?: unknown; tables?: unknown; modelCacheHex?: unknown };
    const schemaVersion = record.schemaVersion;
    if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || !Array.isArray(record.tables) || typeof record.modelCacheHex !== "string") {
      throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: incomplete schema fingerprint");
    }
    const tables = record.tables.map((table) => {
      if (!table || typeof table !== "object") throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: invalid schema table");
      const value = table as { name?: unknown; sql?: unknown };
      if (typeof value.name !== "string" || typeof value.sql !== "string") throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: invalid schema table");
      return { name: value.name, sql: value.sql };
    });
    return buildFinalCutSchemaFingerprint({ schemaVersion, tables, modelCache: Buffer.from(record.modelCacheHex, "hex") });
  }

  private async resolveShadowDatabase(shadow: FinalCutShadowBundle, databaseRelativePath: string): Promise<string> {
    if (isAbsolute(databaseRelativePath)) {
      throw new Error("FINAL_CUT_SHADOW_DATABASE_PATH_INVALID: database path must be relative to the shadow bundle");
    }
    const bundle = await realpath(shadow.shadowBundlePath);
    const candidate = resolve(bundle, databaseRelativePath);
    if (!isWithin(bundle, candidate)) {
      throw new Error("FINAL_CUT_SHADOW_DATABASE_PATH_INVALID: database path escapes the shadow bundle");
    }
    const database = await realpath(candidate);
    if (!isWithin(bundle, database) || !database.endsWith(".fcpevent")) {
      throw new Error("FINAL_CUT_SHADOW_DATABASE_PATH_INVALID: target must be a CurrentVersion.fcpevent database in the shadow bundle");
    }
    return database;
  }

  private async assertRenameSchema(databasePath: string): Promise<void> {
    try {
      const { stdout } = await this.run(databasePath, "PRAGMA query_only=ON; PRAGMA table_info('ZCOLLECTION');");
      const columns = new Set(stdout.split("\n").map((line) => line.split("|")[1]).filter(Boolean));
      for (const required of ["Z_PK", "Z_OPT", "ZNAME"]) {
        if (!columns.has(required)) throw new Error(`missing ${required}`);
      }
    } catch {
      throw new Error("FINAL_CUT_SHADOW_SCHEMA_UNSUPPORTED: expected ZCOLLECTION rename schema is unavailable");
    }
  }

  private async run(databasePath: string, sql: string) {
    return execFile(this.sqliteCommand, [databasePath, sql], { timeout: 30_000, maxBuffer: 1_000_000 });
  }
}

function isWithin(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative !== "" && !pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative);
}

async function digestPath(path: string): Promise<string> {
  const pathStat = await stat(path);
  const digest = createHash("sha256");
  if (pathStat.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) {
      digest.update(entry);
      digest.update(await digestPath(join(path, entry)));
    }
    return digest.digest("hex");
  }
  const { createReadStream } = await import("node:fs");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => { digest.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}
