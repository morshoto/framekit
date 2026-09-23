import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Experimental evidence contracts for Final Cut's undocumented Core Data
 * stores. These contracts intentionally compile only the already-proven
 * shadow control recipe; they never claim a versioned project is writable.
 */
export interface FinalCutSchemaFingerprintInput {
  schemaVersion: number;
  tables: ReadonlyArray<{ name: string; sql: string }>;
  modelCache: Uint8Array;
}

export interface FinalCutSchemaFingerprint {
  schemaVersion: number;
  sqliteMasterDigest: string;
  modelCacheDigest: string;
}

export function buildFinalCutSchemaFingerprint(input: FinalCutSchemaFingerprintInput): FinalCutSchemaFingerprint {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 0) {
    throw new Error("FINAL_CUT_SHADOW_SCHEMA_FINGERPRINT_INVALID: schemaVersion must be a non-negative integer");
  }
  const tables = [...input.tables].sort((left, right) => left.name.localeCompare(right.name));
  if (tables.some((table) => !table.name || !table.sql)) {
    throw new Error("FINAL_CUT_SHADOW_SCHEMA_FINGERPRINT_INVALID: every table requires a name and SQL definition");
  }
  return {
    schemaVersion: input.schemaVersion,
    sqliteMasterDigest: digestText(tables.map((table) => `${table.name}\n${table.sql}\n`).join("")),
    modelCacheDigest: digestBytes(input.modelCache),
  };
}

export function assertFinalCutSchemaFingerprint(
  expected: FinalCutSchemaFingerprint,
  actual: FinalCutSchemaFingerprint,
): void {
  if (expected.schemaVersion !== actual.schemaVersion
    || expected.sqliteMasterDigest !== actual.sqliteMasterDigest
    || expected.modelCacheDigest !== actual.modelCacheDigest) {
    throw new Error("FINAL_CUT_SHADOW_SCHEMA_FINGERPRINT_MISMATCH: Final Cut schema or model cache differs from the proven corpus");
  }
}

export interface FinalCutArchiveReference {
  fromObject: number;
  path: string;
  toObject: number;
}

export interface ParsedFinalCutKeyedArchive {
  archiver: "NSKeyedArchiver";
  version: number;
  top: unknown;
  objects: unknown[];
  references: FinalCutArchiveReference[];
}

export type FinalCutKeyedArchiveJsonDecoder = (payload: Uint8Array) => Promise<unknown>;

/**
 * Decodes a `bplist00` metadata BLOB through macOS `plutil`. The resulting
 * archive remains evidence only: callers must not re-encode it for mutation.
 */
export async function decodeFinalCutKeyedArchive(
  payload: Uint8Array,
  decoder: FinalCutKeyedArchiveJsonDecoder = decodeKeyedArchiveWithPlutil,
): Promise<ParsedFinalCutKeyedArchive> {
  if (!Buffer.from(payload).subarray(0, 8).equals(Buffer.from("bplist00", "ascii"))) {
    throw new Error("FINAL_CUT_SHADOW_ARCHIVE_UNSUPPORTED: metadata BLOB is not a binary plist");
  }
  return parseFinalCutKeyedArchive(await decoder(payload));
}

/** Parse JSON emitted by `plutil -convert json` for an NSKeyedArchiver blob. */
export function parseFinalCutKeyedArchive(value: unknown): ParsedFinalCutKeyedArchive {
  const record = object(value, "archive");
  if (record.$archiver !== "NSKeyedArchiver") {
    throw new Error("FINAL_CUT_SHADOW_ARCHIVE_UNSUPPORTED: archive is not NSKeyedArchiver");
  }
  const version = record.$version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new Error("FINAL_CUT_SHADOW_ARCHIVE_INVALID: $version must be an integer");
  }
  if (!Array.isArray(record.$objects)) {
    throw new Error("FINAL_CUT_SHADOW_ARCHIVE_INVALID: $objects must be an array");
  }
  const top = object(record.$top, "$top");
  const references: FinalCutArchiveReference[] = [];
  for (const [index, item] of record.$objects.entries()) collectReferences(item, index, "$", references);
  for (const reference of references) {
    if (reference.toObject < 0 || reference.toObject >= record.$objects.length) {
      throw new Error("FINAL_CUT_SHADOW_ARCHIVE_INVALID: archive reference points outside $objects");
    }
  }
  return { archiver: "NSKeyedArchiver", version, top, objects: record.$objects, references };
}

/**
 * Candidate archive encoder for the Phase 5 proof gate. It preserves the
 * decoded `$top`/`$objects` UID graph, but callers must still prove exact bytes
 * against a Final Cut-authored archive before using it for mutation.
 */
export async function encodeFinalCutKeyedArchiveWithPythonPlistlib(
  archive: ParsedFinalCutKeyedArchive,
): Promise<Uint8Array> {
  const script = [
    "import base64,json,plistlib,sys",
    "def n(v):",
    "  if isinstance(v,dict) and set(v)=={'CF$UID'}: return plistlib.UID(v['CF$UID'])",
    "  if isinstance(v,dict) and set(v)=={'CF$bytes'}: return base64.b64decode(v['CF$bytes'])",
    "  if isinstance(v,dict): return {str(k): n(x) for k,x in v.items()}",
    "  if isinstance(v,list): return [n(x) for x in v]",
    "  return v",
    "v=json.load(sys.stdin)",
    "archive={'$archiver':'NSKeyedArchiver','$version':v['version'],'$top':n(v['top']),'$objects':n(v['objects'])}",
    "sys.stdout.buffer.write(plistlib.dumps(archive,fmt=plistlib.FMT_BINARY,sort_keys=False))",
  ].join("\n");
  return new Promise<Uint8Array>((resolve, reject) => {
    const process = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.on("error", () => reject(new Error("FINAL_CUT_SHADOW_ARCHIVE_ENCODER_UNAVAILABLE: python3 is unavailable")));
    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FINAL_CUT_SHADOW_ARCHIVE_ENCODER_FAILED: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    process.stdin.end(JSON.stringify({ version: archive.version, top: archive.top, objects: archive.objects }));
  });
}

export interface FinalCutGroundTruthCollection {
  primaryKey: number;
  type: string;
  optimisticVersion: number;
  name?: string;
  identifier?: string;
  metadataId?: number;
}

export interface FinalCutGroundTruthMetadata {
  primaryKey: number;
  collectionPrimaryKey?: number;
  optimisticVersion: number;
  archive: unknown;
  /** SHA-256 of the exact ZDICTIONARYDATA bytes collected before decoding. */
  archiveDigest?: string;
}

export interface FinalCutGroundTruthRelationship {
  parentPrimaryKey: number;
  childPrimaryKey: number;
}

export interface FinalCutGroundTruthSnapshot {
  fingerprint: FinalCutSchemaFingerprint;
  collections: FinalCutGroundTruthCollection[];
  metadata: FinalCutGroundTruthMetadata[];
  relationships: FinalCutGroundTruthRelationship[];
}

export type FinalCutGroundTruthOperation = "project-create" | "project-rename" | "clip-rename" | "marker-add" | "trim";

export interface FinalCutGroundTruthCapture {
  id: string;
  operation: FinalCutGroundTruthOperation;
  before: FinalCutGroundTruthSnapshot;
  after: FinalCutGroundTruthSnapshot;
  nativeEvidence: "unverified" | "reopen-readback";
}

export interface FinalCutGroundTruthCorpus {
  schemaVersion: 1;
  fingerprint: FinalCutSchemaFingerprint;
  captures: FinalCutGroundTruthCapture[];
}

export interface FinalCutGroundTruthCollectorOptions {
  sqliteCommand?: string;
  executor?: (databasePath: string, query: string) => Promise<string>;
  archiveDecoder?: FinalCutKeyedArchiveJsonDecoder;
}

export interface FinalCutGroundTruthPairOptions {
  id: string;
  operation: FinalCutGroundTruthOperation;
  beforeDatabasePath: string;
  afterDatabasePath: string;
  nativeEvidence?: FinalCutGroundTruthCapture["nativeEvidence"];
}

/**
 * Reads a UI-produced before/after event database without changing it. The
 * query deliberately assumes the observed Final Cut Core Data tables; a
 * missing column/table is an unsupported schema, not a partial capture.
 */
export class FinalCutGroundTruthCollector {
  private readonly executor: (databasePath: string, query: string) => Promise<string>;
  private readonly archiveDecoder: FinalCutKeyedArchiveJsonDecoder;

  public constructor(options: FinalCutGroundTruthCollectorOptions = {}) {
    const sqliteCommand = options.sqliteCommand ?? "sqlite3";
    this.executor = options.executor ?? ((databasePath, query) => execFile(
      sqliteCommand,
      ["-readonly", "-batch", "-noheader", databasePath, query],
      { timeout: 30_000, maxBuffer: 32_000_000 },
    ).then(({ stdout }) => stdout));
    this.archiveDecoder = options.archiveDecoder ?? decodeKeyedArchiveWithPlutil;
  }

  public async collect(databasePath: string): Promise<FinalCutGroundTruthSnapshot> {
    const response = await this.executor(databasePath, buildFinalCutGroundTruthSnapshotQuery());
    return parseFinalCutGroundTruthSnapshotResponse(response, this.archiveDecoder);
  }

  public async collectPair(options: FinalCutGroundTruthPairOptions): Promise<FinalCutGroundTruthCapture> {
    const before = await this.collect(options.beforeDatabasePath);
    const after = await this.collect(options.afterDatabasePath);
    return createFinalCutGroundTruthCapture(options.id, options.operation, before, after, options.nativeEvidence);
  }
}

/** The only collector SQL: it starts query_only and emits no arbitrary BLOB text. */
export function buildFinalCutGroundTruthSnapshotQuery(): string {
  return `
PRAGMA query_only=ON;
SELECT json_object(
  'schemaVersion', (SELECT schema_version FROM pragma_schema_version LIMIT 1),
  'tables', COALESCE((SELECT json_group_array(json_object('name', name, 'sql', sql))
    FROM (SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name)), json('[]')),
  'modelCacheHex', (SELECT hex(Z_CONTENT) FROM Z_MODELCACHE LIMIT 1),
  'collections', COALESCE((SELECT json_group_array(json_object(
    'primaryKey', Z_PK, 'type', ZTYPE, 'optimisticVersion', Z_OPT,
    'name', ZNAME, 'identifier', ZIDENTIFIER, 'metadataId', ZMETADATA
  )) FROM (SELECT Z_PK, ZTYPE, Z_OPT, ZNAME, ZIDENTIFIER, ZMETADATA FROM ZCOLLECTION ORDER BY Z_PK)), json('[]')),
  'metadata', COALESCE((SELECT json_group_array(json_object(
    'primaryKey', Z_PK, 'collectionPrimaryKey', ZCOLLECTION,
    'optimisticVersion', Z_OPT, 'archiveHex', hex(ZDICTIONARYDATA)
  )) FROM (SELECT Z_PK, ZCOLLECTION, Z_OPT, ZDICTIONARYDATA FROM ZCOLLECTIONMD ORDER BY Z_PK)), json('[]')),
  'relationships', COALESCE((SELECT json_group_array(json_object(
    'parentPrimaryKey', Z_3PARENTCOLLECTIONS, 'childPrimaryKey', Z_3CHILDCOLLECTIONS
  )) FROM (SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS
            ORDER BY Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS)), json('[]'))
) AS snapshot;`;
}

/** Converts the collector's JSON into a fully decoded, evidence-only snapshot. */
export async function parseFinalCutGroundTruthSnapshotResponse(
  input: string | unknown,
  decoder: FinalCutKeyedArchiveJsonDecoder = decodeKeyedArchiveWithPlutil,
): Promise<FinalCutGroundTruthSnapshot> {
  let parsed: unknown;
  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: collector response is not valid JSON");
  }
  const record = object(parsed, "collector response");
  const schemaVersion = integer(record.schemaVersion, "schemaVersion");
  const modelCacheHex = text(record.modelCacheHex, "modelCacheHex");
  const tables = array(record.tables, "tables").map((value) => {
    const table = object(value, "table");
    return { name: text(table.name, "table.name"), sql: text(table.sql, "table.sql") };
  });
  const collections = array(record.collections, "collections").map((value) => parseCollection(value));
  const metadata = await Promise.all(array(record.metadata, "metadata").map(async (value) => {
    const row = object(value, "metadata");
    const archiveHex = text(row.archiveHex, "metadata.archiveHex");
    if (!/^(?:[\da-fA-F]{2})+$/.test(archiveHex)) {
      throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: metadata.archiveHex must be complete hexadecimal bytes");
    }
    return {
      primaryKey: integer(row.primaryKey, "metadata.primaryKey"),
      collectionPrimaryKey: optionalInteger(row.collectionPrimaryKey, "metadata.collectionPrimaryKey"),
      optimisticVersion: integer(row.optimisticVersion, "metadata.optimisticVersion"),
      archive: await decodeFinalCutKeyedArchive(Buffer.from(archiveHex, "hex"), decoder),
      archiveDigest: digestBytes(Buffer.from(archiveHex, "hex")),
    };
  }));
  const relationships = array(record.relationships, "relationships").map((value) => {
    const row = object(value, "relationship");
    return {
      parentPrimaryKey: integer(row.parentPrimaryKey, "relationship.parentPrimaryKey"),
      childPrimaryKey: integer(row.childPrimaryKey, "relationship.childPrimaryKey"),
    };
  });
  return {
    fingerprint: buildFinalCutSchemaFingerprint({ schemaVersion, tables, modelCache: Buffer.from(modelCacheHex, "hex") }),
    collections,
    metadata,
    relationships,
  };
}

/** Packages one externally performed UI operation for persistence in a corpus. */
export function createFinalCutGroundTruthCapture(
  id: string,
  operation: FinalCutGroundTruthOperation,
  before: FinalCutGroundTruthSnapshot,
  after: FinalCutGroundTruthSnapshot,
  nativeEvidence: FinalCutGroundTruthCapture["nativeEvidence"] = "unverified",
): FinalCutGroundTruthCapture {
  if (!id) throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: capture ID must be non-empty");
  const diff = diffFinalCutGroundTruthSnapshots(before, after);
  if (diff.collectionChanges.length === 0 && diff.relationshipChanges.added.length === 0
    && diff.relationshipChanges.removed.length === 0 && diff.archiveChanges.length === 0) {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: a capture requires an observed change set");
  }
  return { id, operation, before, after, nativeEvidence };
}

/** Persist corpus evidence without overwriting a prior capture set. */
export async function writeFinalCutGroundTruthCorpus(path: string, corpus: FinalCutGroundTruthCorpus): Promise<void> {
  validateFinalCutGroundTruthCorpus(corpus, corpus.fingerprint);
  await writeFile(path, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

/** Load and validate a corpus against the fixed schema fingerprint. */
export async function readFinalCutGroundTruthCorpus(
  path: string,
  fingerprint: FinalCutSchemaFingerprint,
): Promise<FinalCutGroundTruthCorpus> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`FINAL_CUT_SHADOW_CORPUS_INVALID: could not read corpus: ${error instanceof Error ? error.message : String(error)}`);
  }
  const corpus = object(value, "corpus") as unknown as FinalCutGroundTruthCorpus;
  validateFinalCutGroundTruthCorpus(corpus, fingerprint);
  return corpus;
}

export interface FinalCutGroundTruthDiff {
  collectionChanges: Array<{ primaryKey: number; type: string; changed: string[] }>;
  relationshipChanges: {
    added: FinalCutGroundTruthRelationship[];
    removed: FinalCutGroundTruthRelationship[];
  };
  archiveChanges: Array<{ metadataPrimaryKey: number; changed: string[] }>;
}

export function diffFinalCutGroundTruthSnapshots(
  before: FinalCutGroundTruthSnapshot,
  after: FinalCutGroundTruthSnapshot,
): FinalCutGroundTruthDiff {
  assertFinalCutSchemaFingerprint(before.fingerprint, after.fingerprint);
  const beforeCollections = new Map(before.collections.map((row) => [row.primaryKey, row]));
  const afterCollections = new Map(after.collections.map((row) => [row.primaryKey, row]));
  const collectionChanges = [...new Set([...beforeCollections.keys(), ...afterCollections.keys()])]
    .sort((left, right) => left - right)
    .flatMap((primaryKey) => {
      const left = beforeCollections.get(primaryKey);
      const right = afterCollections.get(primaryKey);
      if (!left || !right) return [{ primaryKey, type: left?.type ?? right!.type, changed: [left ? "removed" : "added"] }];
      const changed = changedFields(left as unknown as Record<string, unknown>, right as unknown as Record<string, unknown>);
      return changed.length === 0 ? [] : [{ primaryKey, type: right.type, changed }];
    });

  const beforeRelationships = new Map(before.relationships.map((edge) => [relationshipKey(edge), edge]));
  const afterRelationships = new Map(after.relationships.map((edge) => [relationshipKey(edge), edge]));
  const added = [...afterRelationships].filter(([key]) => !beforeRelationships.has(key)).map(([, edge]) => edge);
  const removed = [...beforeRelationships].filter(([key]) => !afterRelationships.has(key)).map(([, edge]) => edge);

  const beforeMetadata = new Map(before.metadata.map((row) => [row.primaryKey, row]));
  const archiveChanges = after.metadata.flatMap((row) => {
    const previous = beforeMetadata.get(row.primaryKey);
    if (!previous) return [{ metadataPrimaryKey: row.primaryKey, changed: ["added"] }];
    const changed = changedJson(previous.archive, row.archive, "$");
    if (previous.archiveDigest !== row.archiveDigest) changed.push("archiveDigest");
    return changed.length === 0 ? [] : [{ metadataPrimaryKey: row.primaryKey, changed }];
  });
  for (const row of before.metadata) {
    if (!after.metadata.some((candidate) => candidate.primaryKey === row.primaryKey)) {
      archiveChanges.push({ metadataPrimaryKey: row.primaryKey, changed: ["removed"] });
    }
  }
  return { collectionChanges, relationshipChanges: { added, removed }, archiveChanges };
}

export function validateFinalCutGroundTruthCorpus(
  corpus: FinalCutGroundTruthCorpus,
  fingerprint: FinalCutSchemaFingerprint,
): void {
  if (corpus.schemaVersion !== 1 || corpus.captures.length === 0) {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: corpus must contain captures with schemaVersion 1");
  }
  assertFinalCutSchemaFingerprint(fingerprint, corpus.fingerprint);
  const ids = new Set<string>();
  for (const capture of corpus.captures) {
    if (!capture.id || ids.has(capture.id)) throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: capture IDs must be non-empty and unique");
    ids.add(capture.id);
    assertFinalCutSchemaFingerprint(fingerprint, capture.before.fingerprint);
    assertFinalCutSchemaFingerprint(fingerprint, capture.after.fingerprint);
    validateGroundTruthSnapshot(capture.before);
    validateGroundTruthSnapshot(capture.after);
    const diff = diffFinalCutGroundTruthSnapshots(capture.before, capture.after);
    if (diff.collectionChanges.length === 0 && diff.relationshipChanges.added.length === 0
      && diff.relationshipChanges.removed.length === 0 && diff.archiveChanges.length === 0) {
      throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: every capture must contain one observed change set");
    }
  }
}

function validateGroundTruthSnapshot(snapshot: FinalCutGroundTruthSnapshot): void {
  const collectionIds = new Set<number>();
  for (const row of snapshot.collections) {
    if (collectionIds.has(row.primaryKey)) throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: duplicate collection primary key");
    collectionIds.add(row.primaryKey);
  }
  const metadataIds = new Set<number>();
  for (const row of snapshot.metadata) {
    if (metadataIds.has(row.primaryKey)) throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: duplicate metadata primary key");
    metadataIds.add(row.primaryKey);
    if (row.archiveDigest !== undefined && !/^[a-f0-9]{64}$/.test(row.archiveDigest)) {
      throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: archiveDigest must be a SHA-256 hex digest");
    }
  }
  const relationshipIds = new Set(snapshot.relationships.map(relationshipKey));
  if (relationshipIds.size !== snapshot.relationships.length) {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: duplicate relationship edge");
  }
}

export type FinalCutShadowRecipeRequest =
  | {
      kind: "collection-rename-control";
      captureId: string;
      collectionPrimaryKey: number;
      expectedOptimisticVersion: number;
      name: string;
    }
  | {
      kind: "versioned-project-materialization";
      captureId: string;
      projectName: string;
      sequenceName: string;
    };

export type FinalCutShadowRecipe = Omit<Extract<FinalCutShadowRecipeRequest, { kind: "collection-rename-control" }>, "captureId">;

/**
 * Produces only an allowlisted, observed control recipe. A versioned project
 * requires a reopen-proven archive encoder and is deliberately rejected.
 */
export function compileFinalCutShadowRecipe(
  corpus: FinalCutGroundTruthCorpus,
  fingerprint: FinalCutSchemaFingerprint,
  request: FinalCutShadowRecipeRequest,
): FinalCutShadowRecipe {
  validateFinalCutGroundTruthCorpus(corpus, fingerprint);
  const capture = corpus.captures.find((candidate) => candidate.id === request.captureId);
  if (!capture) throw new Error("FINAL_CUT_SHADOW_RECIPE_UNPROVEN: referenced ground-truth capture is unavailable");
  if (request.kind === "versioned-project-materialization") {
    throw new Error("FINAL_CUT_SHADOW_RECIPE_UNPROVEN: versioned project materialization requires a reopen-proven archive encoder and graph recipe");
  }
  if (capture.operation !== "project-rename" || !Number.isSafeInteger(request.collectionPrimaryKey)
    || request.collectionPrimaryKey < 1 || !Number.isSafeInteger(request.expectedOptimisticVersion)
    || request.expectedOptimisticVersion < 1 || !request.name || request.name.includes("\0")) {
    throw new Error("FINAL_CUT_SHADOW_RECIPE_INVALID: rename control request is invalid or does not match its proof operation");
  }
  return {
    kind: request.kind,
    collectionPrimaryKey: request.collectionPrimaryKey,
    expectedOptimisticVersion: request.expectedOptimisticVersion,
    name: request.name,
  };
}

function collectReferences(value: unknown, fromObject: number, path: string, result: FinalCutArchiveReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, fromObject, `${path}[${index}]`, result));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && Number.isSafeInteger(record["CF$UID"])) {
    result.push({ fromObject, path, toObject: record["CF$UID"] as number });
    return;
  }
  for (const [key, child] of Object.entries(record)) collectReferences(child, fromObject, `${path}.${key}`, result);
}

function changedFields(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().filter((key) => !equal(left[key], right[key]));
}

function changedJson(left: unknown, right: unknown, path: string): string[] {
  if (equal(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const changed: string[] = [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      changed.push(...changedJson(left[index], right[index], `${path}[${index}]`));
    }
    return changed;
  }
  if (isObject(left) && isObject(right)) {
    const changed: string[] = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      changed.push(...changedJson(left[key], right[key], `${path}.${key}`));
    }
    return changed;
  }
  return [path];
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function relationshipKey(edge: FinalCutGroundTruthRelationship): string {
  return `${edge.parentPrimaryKey}:${edge.childPrimaryKey}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`FINAL_CUT_SHADOW_ARCHIVE_INVALID: ${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`FINAL_CUT_SHADOW_CORPUS_INVALID: ${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`FINAL_CUT_SHADOW_CORPUS_INVALID: ${label} must be text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FINAL_CUT_SHADOW_CORPUS_INVALID: ${label} must be a non-negative integer`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : integer(value, label);
}

function parseCollection(value: unknown): FinalCutGroundTruthCollection {
  const row = object(value, "collection");
  const name = row.name;
  const identifier = row.identifier;
  const metadataId = row.metadataId;
  if (name !== null && name !== undefined && typeof name !== "string") {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: collection.name must be text or null");
  }
  if (identifier !== null && identifier !== undefined && typeof identifier !== "string") {
    throw new Error("FINAL_CUT_SHADOW_CORPUS_INVALID: collection.identifier must be text or null");
  }
  return {
    primaryKey: integer(row.primaryKey, "collection.primaryKey"),
    type: text(row.type, "collection.type"),
    optimisticVersion: integer(row.optimisticVersion, "collection.optimisticVersion"),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof identifier === "string" ? { identifier } : {}),
    ...(metadataId === null || metadataId === undefined ? {} : { metadataId: integer(metadataId, "collection.metadataId") }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function decodeKeyedArchiveWithPlutil(payload: Uint8Array): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const process = spawn("plutil", ["-convert", "json", "-o", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.on("error", () => reject(new Error("FINAL_CUT_SHADOW_ARCHIVE_UNAVAILABLE: plutil is unavailable")));
    process.on("close", (code) => {
      if (code !== 0) {
        decodeKeyedArchiveWithPythonPlistlib(payload).then(resolve, (fallbackError) => {
          reject(new Error(`FINAL_CUT_SHADOW_ARCHIVE_INVALID: plutil failed: ${Buffer.concat(stderr).toString("utf8").trim()}; plistlib fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`));
        });
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("FINAL_CUT_SHADOW_ARCHIVE_INVALID: plutil did not return JSON"));
      }
    });
    process.stdin.end(payload);
  });
}

/** `plutil -convert json` rejects Apple's UID objects; plistlib preserves them. */
async function decodeKeyedArchiveWithPythonPlistlib(payload: Uint8Array): Promise<unknown> {
  const script = [
    "import base64,json,plistlib,sys,datetime",
    "def n(v):",
    "  if isinstance(v, plistlib.UID): return {'CF$UID': v.data}",
    "  if isinstance(v,bytes): return {'CF$bytes': base64.b64encode(v).decode('ascii')}",
    "  if isinstance(v,dict): return {str(k): n(x) for k,x in v.items()}",
    "  if isinstance(v,list): return [n(x) for x in v]",
    "  if isinstance(v,(datetime.datetime,datetime.date)): return v.isoformat()",
    "  return v",
    "print(json.dumps(n(plistlib.loads(sys.stdin.buffer.read())), separators=(',',':')))",
  ].join("\n");
  return new Promise<unknown>((resolve, reject) => {
    const process = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.on("error", () => reject(new Error("python3 is unavailable for binary plist decoding")));
    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "plistlib failed"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("plistlib did not return JSON"));
      }
    });
    process.stdin.end(payload);
  });
}
