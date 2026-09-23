import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ContextRevision } from "@framekit/runtime";

export const FINAL_CUT_SQLITE_INSPECTION_BACKEND = "final-cut-sqlite-read-only" as const;
export const FINAL_CUT_SQLITE_INSPECTION_TIMEOUT_MS = 30_000;

export type FinalCutSqliteDatabaseKind = "flexolibrary" | "fcpevent" | "unknown";
export type FinalCutSqliteCoverage = "exact" | "partial" | "unknown";

export type FinalCutSqliteInspectionIssueCode =
  | "FINAL_CUT_SQLITE_FIELD_UNAVAILABLE"
  | "FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE"
  | "FINAL_CUT_SQLITE_OPAQUE_PAYLOAD"
  | "FINAL_CUT_SQLITE_RESPONSE_INVALID"
  | "FINAL_CUT_SQLITE_REVISION_UNAVAILABLE";

export interface FinalCutSqliteInspectionIssue {
  code: FinalCutSqliteInspectionIssueCode;
  message: string;
  path?: string;
  retryable: boolean;
}

export interface FinalCutSqliteTableColumn {
  name: string;
  type: string;
  primaryKey: number;
}

export interface FinalCutSqliteTable {
  name: string;
  sql: string;
  columns: FinalCutSqliteTableColumn[];
  rowCount?: number;
}

export interface FinalCutSqliteCollectionTypeCount {
  type: string;
  count: number;
}

export interface FinalCutSqliteCollectionRow {
  primaryKey: number;
  type: string;
  identifier?: string;
  optimisticVersion?: number;
  catalogId?: number;
  metadataId?: number;
}

export interface FinalCutSqliteMetadataRow {
  primaryKey: number;
  collectionId?: number;
  identifier?: string;
  bytes: number;
  archive?: string;
}

/** JSON emitted by the read-only sqlite3 query. It intentionally excludes BLOB contents. */
export interface FinalCutSqliteInspectionPayload {
  version: 1;
  schemaVersion: number;
  userVersion: number;
  tables: FinalCutSqliteTable[];
  rowCounts: Record<string, number>;
  collectionTypes: FinalCutSqliteCollectionTypeCount[];
  collectionRows: FinalCutSqliteCollectionRow[];
  metadataRows: FinalCutSqliteMetadataRow[];
}

export interface FinalCutSqliteCoverageReport {
  complete: false;
  projectIdentity: FinalCutSqliteCoverage;
  sequenceIdentity: FinalCutSqliteCoverage;
  clipOccurrences: FinalCutSqliteCoverage;
  mediaIdentity: FinalCutSqliteCoverage;
  rationalTiming: FinalCutSqliteCoverage;
  roles: FinalCutSqliteCoverage;
  storylineRelationships: FinalCutSqliteCoverage;
  markersCaptions: FinalCutSqliteCoverage;
  revision: FinalCutSqliteCoverage;
}

/** A source-bound storage observation, never a canonical ProjectSnapshot. */
export interface FinalCutSqliteObservation extends FinalCutSqliteInspectionPayload {
  backend: typeof FINAL_CUT_SQLITE_INSPECTION_BACKEND;
  sourcePath: string;
  databaseKind: FinalCutSqliteDatabaseKind;
  digest: string;
  revision: ContextRevision;
  canonical: false;
  coverage: FinalCutSqliteCoverageReport;
}

export type FinalCutSqliteInspectionResult =
  | {
      status: "partial";
      observation: FinalCutSqliteObservation;
      issues: FinalCutSqliteInspectionIssue[];
    }
  | {
      status: "unavailable" | "error";
      error: FinalCutSqliteInspectionError;
    };

export interface FinalCutSqliteInspectionError {
  code: FinalCutSqliteInspectionIssueCode;
  message: string;
  retryable: boolean;
}

type JsonRecord = Record<string, unknown>;
type ParseFailure = { readonly parseFailure: true; message: string };
const execFile = promisify(execFileCallback);

export interface FinalCutSqliteInspectionProviderOptions {
  sqliteCommand?: string;
  executor?: (databasePath: string, query: string, timeoutMs: number) => Promise<string>;
  digest?: (databasePath: string) => Promise<string>;
  timestamp?: () => string;
}

export class FinalCutSqliteInspectionProviderError extends Error {
  public readonly code: FinalCutSqliteInspectionIssueCode;
  public readonly retryable: boolean;

  public constructor(public readonly failure: FinalCutSqliteInspectionError) {
    super(`${failure.code}: ${failure.message}`);
    this.name = "FinalCutSqliteInspectionProviderError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }

  public toJSON(): FinalCutSqliteInspectionError {
    return { ...this.failure };
  }
}

/**
 * Read-only inspection of Final Cut's Core Data SQLite stores.
 *
 * The provider intentionally returns an observation rather than ProjectSnapshot:
 * the current schema exposes useful object/type/version hints, while the
 * timeline payload lives in undocumented archived BLOBs.
 */
export class FinalCutSqliteInspectionProvider {
  public readonly backend = FINAL_CUT_SQLITE_INSPECTION_BACKEND;
  private readonly executor: (databasePath: string, query: string, timeoutMs: number) => Promise<string>;
  private readonly digest: (databasePath: string) => Promise<string>;
  private readonly timestamp: () => string;

  public constructor(options: FinalCutSqliteInspectionProviderOptions = {}) {
    const sqliteCommand = options.sqliteCommand ?? "sqlite3";
    this.executor = options.executor ?? ((databasePath, query, timeoutMs) => executeSqliteInspection(
      sqliteCommand,
      databasePath,
      query,
      timeoutMs,
    ));
    this.digest = options.digest ?? hashSqliteFile;
    this.timestamp = options.timestamp ?? (() => new Date().toISOString());
  }

  public async inspect(databasePath: string): Promise<FinalCutSqliteInspectionResult> {
    try {
      const [response, digest] = await Promise.all([
        this.executor(databasePath, buildFinalCutSqliteInspectionQuery(), FINAL_CUT_SQLITE_INSPECTION_TIMEOUT_MS),
        this.digest(databasePath),
      ]);
      const parsed = parseFinalCutSqliteInspectionResponse(response);
      if (parsed.status === "error") return parsed;

      const sequence = parsed.payload.collectionRows.reduce(
        (maximum, row) => Math.max(maximum, row.optimisticVersion ?? 0),
        0,
      );
      const observation: FinalCutSqliteObservation = {
        ...parsed.payload,
        backend: this.backend,
        sourcePath: databasePath,
        databaseKind: databaseKindForPath(databasePath),
        digest,
        revision: { id: digest, sequence, timestamp: this.timestamp() },
        canonical: false,
        coverage: coverageFor(parsed.payload),
      };
      return { status: "partial", observation, issues: parsed.issues };
    } catch (error) {
      return {
        status: "unavailable",
        error: unavailableError(error),
      };
    }
  }

  public async readObservation(databasePath: string): Promise<FinalCutSqliteObservation> {
    const result = await this.inspect(databasePath);
    if (result.status === "partial") return result.observation;
    throw new FinalCutSqliteInspectionProviderError(result.error);
  }
}

/** Build the only SQL sent to a Final Cut store; it is schema/data read-only. */
export function buildFinalCutSqliteInspectionQuery(): string {
  return `
PRAGMA query_only=ON;
SELECT json_object(
  'version', 1,
  'schemaVersion', (SELECT schema_version FROM pragma_schema_version LIMIT 1),
  'userVersion', (SELECT user_version FROM pragma_user_version LIMIT 1),
  'tables', COALESCE((SELECT json_group_array(json_object(
    'name', name,
    'sql', sql,
    'columns', (SELECT COALESCE(json_group_array(json_object(
      'name', p.name,
      'type', p.type,
      'primaryKey', p.pk
    )), json('[]')) FROM pragma_table_info(m.name) AS p)
  )) FROM (SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name) AS m), json('[]')),
  'rowCounts', json_object(
    'ZCATALOGROOT', (SELECT COUNT(*) FROM ZCATALOGROOT),
    'ZCATALOGROOTMD', (SELECT COUNT(*) FROM ZCATALOGROOTMD),
    'ZCOLLECTION', (SELECT COUNT(*) FROM ZCOLLECTION),
    'ZCOLLECTIONMD', (SELECT COUNT(*) FROM ZCOLLECTIONMD),
    'Z_3CHILDCOLLECTIONS', (SELECT COUNT(*) FROM Z_3CHILDCOLLECTIONS),
    'Z_METADATA', (SELECT COUNT(*) FROM Z_METADATA),
    'Z_MODELCACHE', (SELECT COUNT(*) FROM Z_MODELCACHE),
    'Z_PRIMARYKEY', (SELECT COUNT(*) FROM Z_PRIMARYKEY)
  ),
  'collectionTypes', COALESCE((SELECT json_group_array(json_object(
    'type', type,
    'count', count
  )) FROM (
    SELECT COALESCE(ZTYPE, '') AS type, COUNT(*) AS count
    FROM ZCOLLECTION
    GROUP BY ZTYPE
    ORDER BY type
  )), json('[]')),
  'collectionRows', COALESCE((SELECT json_group_array(json_object(
    'primaryKey', Z_PK,
    'type', ZTYPE,
    'identifier', ZIDENTIFIER,
    'optimisticVersion', Z_OPT,
    'catalogId', ZCATALOG,
    'metadataId', ZMETADATA
  )) FROM (
    SELECT Z_PK, ZTYPE, ZIDENTIFIER, Z_OPT, ZCATALOG, ZMETADATA
    FROM ZCOLLECTION
    WHERE ZTYPE LIKE 'FFMediaEventProject%'
       OR ZTYPE IN ('FFAnchoredSequence', 'FFAnchoredClip', 'FFAsset', 'FFMediaRep')
    ORDER BY Z_PK
  )), json('[]')),
  'metadataRows', COALESCE((SELECT json_group_array(json_object(
    'primaryKey', Z_PK,
    'collectionId', ZCOLLECTION,
    'identifier', ZIDENTIFIER,
    'bytes', length(ZDICTIONARYDATA),
    'archive', CASE
      WHEN substr(ZDICTIONARYDATA, 1, 8) = x'62706c6973743030' THEN 'NSKeyedArchiver'
      WHEN ZDICTIONARYDATA IS NULL THEN NULL
      ELSE 'opaque'
    END
  )) FROM (
    SELECT Z_PK, ZCOLLECTION, ZIDENTIFIER, ZDICTIONARYDATA
    FROM ZCOLLECTIONMD
    ORDER BY Z_PK
  )), json('[]'))
) AS inspection;`;
}

export function parseFinalCutSqliteInspectionResponse(input: string | unknown):
  | { status: "partial"; payload: FinalCutSqliteInspectionPayload; issues: FinalCutSqliteInspectionIssue[] }
  | { status: "error"; error: FinalCutSqliteInspectionError } {
  let payload: unknown;
  try {
    payload = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    return invalidResponse(`response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(payload);
  if (!record) return invalidResponse("response must be an object");
  if (record.version !== 1) return invalidResponse("version must be 1");

  const schemaVersion = integerField(record.schemaVersion, "schemaVersion");
  const userVersion = integerField(record.userVersion, "userVersion");
  const tables = parseTables(record.tables);
  const rowCounts = parseNumberMap(record.rowCounts, "rowCounts");
  const collectionTypes = parseCollectionTypes(record.collectionTypes);
  const collectionRows = parseCollectionRows(record.collectionRows);
  const metadataRows = parseMetadataRows(record.metadataRows);
  const firstFailure = [schemaVersion, userVersion]
    .find((value): value is ParseFailure => isParseFailure(value));
  if (firstFailure || typeof tables === "string" || typeof rowCounts === "string"
    || typeof collectionTypes === "string" || typeof collectionRows === "string" || typeof metadataRows === "string") {
    return invalidResponse(
      firstFailure?.message
        ?? [tables, rowCounts, collectionTypes, collectionRows, metadataRows]
          .find((value): value is string => typeof value === "string")
        ?? "unknown validation failure",
    );
  }

  return {
    status: "partial",
    payload: {
      version: 1,
      schemaVersion: schemaVersion as number,
      userVersion: userVersion as number,
      tables,
      rowCounts,
      collectionTypes,
      collectionRows,
      metadataRows,
    },
    issues: [
      {
        code: "FINAL_CUT_SQLITE_OPAQUE_PAYLOAD",
        message: "ZCOLLECTIONMD.ZDICTIONARYDATA is an undocumented archived payload; timeline fields are not promoted to canonical state",
        path: "ZCOLLECTIONMD.ZDICTIONARYDATA",
        retryable: false,
      },
      {
        code: "FINAL_CUT_SQLITE_REVISION_UNAVAILABLE",
        message: "SQLite digest and Z_OPT provide storage-change evidence, not a target-bound Final Cut editor revision",
        path: "revision",
        retryable: false,
      },
    ],
  };
}

export interface FinalCutSqliteObservationComparison {
  status: "unchanged" | "changed";
  previousDigest: string;
  currentDigest: string;
  reasons: string[];
}

export function compareFinalCutSqliteObservations(
  previous: FinalCutSqliteObservation,
  current: FinalCutSqliteObservation,
): FinalCutSqliteObservationComparison {
  const reasons: string[] = [];
  if (previous.digest !== current.digest) reasons.push("SQLite file digest changed");
  if (previous.schemaVersion !== current.schemaVersion) reasons.push("SQLite schema version changed");
  if (previous.revision.sequence !== current.revision.sequence) reasons.push("SQLite object version changed");
  return {
    status: reasons.length > 0 ? "changed" : "unchanged",
    previousDigest: previous.digest,
    currentDigest: current.digest,
    reasons,
  };
}

async function executeSqliteInspection(
  sqliteCommand: string,
  databasePath: string,
  query: string,
  timeoutMs: number,
): Promise<string> {
  const result = await execFile(sqliteCommand, ["-readonly", "-batch", "-noheader", databasePath, query], {
    maxBuffer: 8_000_000,
    timeout: timeoutMs,
  });
  return result.stdout.trim();
}

async function hashSqliteFile(databasePath: string): Promise<string> {
  const bytes = await readFile(databasePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function databaseKindForPath(databasePath: string): FinalCutSqliteDatabaseKind {
  const fileName = basename(databasePath);
  if (fileName === "CurrentVersion.flexolibrary") return "flexolibrary";
  if (fileName === "CurrentVersion.fcpevent") return "fcpevent";
  return "unknown";
}

function coverageFor(payload: FinalCutSqliteInspectionPayload): FinalCutSqliteCoverageReport {
  const hasProject = payload.collectionTypes.some(({ type }) => type === "FFMediaEventProject");
  const hasMedia = payload.collectionTypes.some(({ type }) => ["FFAsset", "FFMediaRep"].includes(type));
  return {
    complete: false,
    projectIdentity: hasProject ? "partial" : "unknown",
    sequenceIdentity: "unknown",
    clipOccurrences: "unknown",
    mediaIdentity: hasMedia ? "partial" : "unknown",
    rationalTiming: "unknown",
    roles: "unknown",
    storylineRelationships: "unknown",
    markersCaptions: "unknown",
    revision: "partial",
  };
}

function unavailableError(error: unknown): FinalCutSqliteInspectionError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE",
    message: `Final Cut SQLite inspection is unavailable: ${message}`,
    retryable: /busy|locked|timed out|timeout|temporar/i.test(message),
  };
}

function invalidResponse(message: string): { status: "error"; error: FinalCutSqliteInspectionError } {
  return {
    status: "error",
    error: {
      code: "FINAL_CUT_SQLITE_RESPONSE_INVALID",
      message: `Final Cut SQLite response is invalid: ${message}`,
      retryable: false,
    },
  };
}

function parseTables(value: unknown): FinalCutSqliteTable[] | string {
  if (!Array.isArray(value)) return "tables must be an array";
  const result: FinalCutSqliteTable[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `tables[${index}] must be an object`;
    const name = textField(record.name, `tables[${index}].name`);
    const sql = textField(record.sql, `tables[${index}].sql`);
    const columns = parseColumns(record.columns, `tables[${index}].columns`);
    if (isParseFailure(name) || isParseFailure(sql) || typeof columns === "string") {
      return isParseFailure(name) ? name.message
        : isParseFailure(sql) ? sql.message : columns as string;
    }
    result.push({ name, sql, columns });
  }
  return result;
}

function parseColumns(value: unknown, path: string): FinalCutSqliteTableColumn[] | string {
  if (!Array.isArray(value)) return `${path} must be an array`;
  const result: FinalCutSqliteTableColumn[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `${path}[${index}] must be an object`;
    const name = textField(record.name, `${path}[${index}].name`);
    const type = textField(record.type, `${path}[${index}].type`);
    const primaryKey = integerField(record.primaryKey, `${path}[${index}].primaryKey`);
    if (isParseFailure(name) || isParseFailure(type) || isParseFailure(primaryKey)) {
      return isParseFailure(name) ? name.message
        : isParseFailure(type) ? type.message : (primaryKey as ParseFailure).message;
    }
    result.push({ name, type, primaryKey });
  }
  return result;
}

function parseNumberMap(value: unknown, path: string): Record<string, number> | string {
  const record = asRecord(value);
  if (!record) return `${path} must be an object`;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    const number = integerField(item, `${path}.${key}`);
    if (isParseFailure(number)) return number.message;
    result[key] = number;
  }
  return result;
}

function parseCollectionTypes(value: unknown): FinalCutSqliteCollectionTypeCount[] | string {
  if (!Array.isArray(value)) return "collectionTypes must be an array";
  const result: FinalCutSqliteCollectionTypeCount[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `collectionTypes[${index}] must be an object`;
    const type = textField(record.type, `collectionTypes[${index}].type`);
    const count = integerField(record.count, `collectionTypes[${index}].count`);
    if (isParseFailure(type) || isParseFailure(count)) {
      return isParseFailure(type) ? type.message : (count as ParseFailure).message;
    }
    result.push({ type, count });
  }
  return result;
}

function parseCollectionRows(value: unknown): FinalCutSqliteCollectionRow[] | string {
  if (!Array.isArray(value)) return "collectionRows must be an array";
  const result: FinalCutSqliteCollectionRow[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `collectionRows[${index}] must be an object`;
    const primaryKey = integerField(record.primaryKey, `collectionRows[${index}].primaryKey`);
    const type = textField(record.type, `collectionRows[${index}].type`);
    if (isParseFailure(primaryKey) || isParseFailure(type)) {
      return isParseFailure(primaryKey) ? primaryKey.message : (type as ParseFailure).message;
    }
    const identifier = optionalText(record.identifier, `collectionRows[${index}].identifier`);
    const optimisticVersion = optionalNumber(record.optimisticVersion, `collectionRows[${index}].optimisticVersion`);
    const catalogId = optionalNumber(record.catalogId, `collectionRows[${index}].catalogId`);
    const metadataId = optionalNumber(record.metadataId, `collectionRows[${index}].metadataId`);
    if (isParseFailure(identifier)) return identifier.message;
    if (isParseFailure(optimisticVersion)) return optimisticVersion.message;
    if (isParseFailure(catalogId)) return catalogId.message;
    if (isParseFailure(metadataId)) return metadataId.message;
    result.push({
      primaryKey,
      type,
      ...(typeof identifier === "string" ? { identifier } : {}),
      ...(typeof optimisticVersion === "number" ? { optimisticVersion } : {}),
      ...(typeof catalogId === "number" ? { catalogId } : {}),
      ...(typeof metadataId === "number" ? { metadataId } : {}),
    });
  }
  return result;
}

function parseMetadataRows(value: unknown): FinalCutSqliteMetadataRow[] | string {
  if (!Array.isArray(value)) return "metadataRows must be an array";
  const result: FinalCutSqliteMetadataRow[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) return `metadataRows[${index}] must be an object`;
    const primaryKey = integerField(record.primaryKey, `metadataRows[${index}].primaryKey`);
    const bytes = integerField(record.bytes, `metadataRows[${index}].bytes`);
    if (isParseFailure(primaryKey) || isParseFailure(bytes)) {
      return isParseFailure(primaryKey) ? primaryKey.message : (bytes as ParseFailure).message;
    }
    const collectionId = optionalNumber(record.collectionId, `metadataRows[${index}].collectionId`);
    const identifier = optionalText(record.identifier, `metadataRows[${index}].identifier`);
    const archive = optionalText(record.archive, `metadataRows[${index}].archive`);
    if (isParseFailure(collectionId)) return collectionId.message;
    if (isParseFailure(identifier)) return identifier.message;
    if (isParseFailure(archive)) return archive.message;
    result.push({
      primaryKey,
      bytes,
      ...(typeof collectionId === "number" ? { collectionId } : {}),
      ...(typeof identifier === "string" ? { identifier } : {}),
      ...(typeof archive === "string" ? { archive } : {}),
    });
  }
  return result;
}

function optionalText(value: unknown, path: string): string | undefined | ParseFailure {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return failure(`${path} must be a string or null`);
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined | ParseFailure {
  if (value === undefined || value === null) return undefined;
  const number = integerField(value, path);
  return isParseFailure(number) ? number : number;
}

function textField(value: unknown, path: string): string | ParseFailure {
  return typeof value === "string" ? value : failure(`${path} must be a string`);
}

function integerField(value: unknown, path: string): number | ParseFailure {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : failure(`${path} must be a safe integer`);
}

function failure(message: string): ParseFailure {
  return { parseFailure: true, message };
}

function isParseFailure(value: unknown): value is ParseFailure {
  return Boolean(value && typeof value === "object" && (value as ParseFailure).parseFailure === true);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
