import { createHash } from "node:crypto";
import { readFile as readFileCallback, stat as statCallback } from "node:fs";
import { promisify } from "node:util";
import type { ContextRevision } from "@framekit/runtime";
import {
  FinalCutSqliteInspectionProvider,
  type FinalCutSqliteInspectionResult,
  type FinalCutSqliteCollectionRow,
  type FinalCutSqliteMetadataRow,
  type FinalCutSqliteObservation,
} from "./sqlite-inspection.js";

const readFile = promisify(readFileCallback);
const stat = promisify(statCallback);

export const FINAL_CUT_SQLITE_WAL_BACKEND = "final-cut-sqlite-wal-read-only" as const;
export const FINAL_CUT_SQLITE_WAL_SCHEMA_VERSION = 1 as const;

export interface FinalCutSqliteObservationTarget {
  projectId: string;
  sequenceId: string;
}

export interface FinalCutSqliteMaterializationProvenance {
  framekitRevision: ContextRevision;
  artifactDigest: string;
  target: FinalCutSqliteObservationTarget;
}

export interface FinalCutSqliteStorageFingerprint {
  path: string;
  present: boolean;
  bytes?: number;
  digest?: string;
  modifiedAt?: string;
}

export interface FinalCutSqliteWalObservation {
  schemaVersion: typeof FINAL_CUT_SQLITE_WAL_SCHEMA_VERSION;
  backend: typeof FINAL_CUT_SQLITE_WAL_BACKEND;
  canonical: false;
  target: FinalCutSqliteObservationTarget;
  provenance: FinalCutSqliteMaterializationProvenance;
  finalCutVersion: string;
  database: FinalCutSqliteObservation;
  storage: {
    database: FinalCutSqliteStorageFingerprint;
    wal: FinalCutSqliteStorageFingerprint;
    shm: FinalCutSqliteStorageFingerprint;
    capturedAt: string;
    freshness: "storage-observed";
  };
  coverage: {
    storage: "observed";
    structuralRows: "partial";
    archivedPayloads: "opaque";
    semanticOperation: "not-observable";
    editorFreshness: "unknown";
    canonicalTimeline: "unavailable";
  };
}

export type FinalCutSqliteWalObservationResult =
  | { status: "observed"; observation: FinalCutSqliteWalObservation; issues: string[] }
  | { status: "unavailable" | "error"; error: { code: string; message: string; retryable: boolean } };

export interface FinalCutSqliteWalObservationProviderOptions {
  inspectionProvider?: Pick<FinalCutSqliteInspectionProvider, "inspect">;
  readFile?: (path: string) => Promise<Uint8Array>;
  statFile?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  timestamp?: () => string;
}

export interface FinalCutSqliteWalCaptureRequest {
  databasePath: string;
  walPath?: string;
  shmPath?: string;
  target: FinalCutSqliteObservationTarget;
  provenance: FinalCutSqliteMaterializationProvenance;
  finalCutVersion: string;
}

/** Read-only DB/WAL/SHM observation. This provider never opens a writable SQLite handle. */
export class FinalCutSqliteWalObservationProvider {
  private readonly inspectionProvider: Pick<FinalCutSqliteInspectionProvider, "inspect">;
  private readonly readFile: (path: string) => Promise<Uint8Array>;
  private readonly statFile: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  private readonly timestamp: () => string;

  public constructor(options: FinalCutSqliteWalObservationProviderOptions = {}) {
    this.inspectionProvider = options.inspectionProvider ?? new FinalCutSqliteInspectionProvider();
    this.readFile = options.readFile ?? (async (path) => readFile(path));
    this.statFile = options.statFile ?? (async (path) => {
      const result = await stat(path);
      return { size: result.size, mtimeMs: result.mtimeMs };
    });
    this.timestamp = options.timestamp ?? (() => new Date().toISOString());
  }

  public async capture(request: FinalCutSqliteWalCaptureRequest): Promise<FinalCutSqliteWalObservationResult> {
    try {
      const target = parseTarget(request.target);
      const provenance = parseProvenance(request.provenance, target);
      const finalCutVersion = nonEmpty(request.finalCutVersion, "finalCutVersion");
      const databasePath = nonEmpty(request.databasePath, "databasePath");
      const inspection = await this.inspectionProvider.inspect(databasePath);
      if (inspection.status !== "partial") return inspectionFailure(inspection);
      const storage = await Promise.all([
        this.fingerprint(databasePath, true),
        this.fingerprint(request.walPath ?? `${databasePath}-wal`, false),
        this.fingerprint(request.shmPath ?? `${databasePath}-shm`, false),
      ]);
      const observation: FinalCutSqliteWalObservation = {
        schemaVersion: FINAL_CUT_SQLITE_WAL_SCHEMA_VERSION,
        backend: FINAL_CUT_SQLITE_WAL_BACKEND,
        canonical: false,
        target,
        provenance,
        finalCutVersion,
        database: inspection.observation,
        storage: {
          database: storage[0],
          wal: storage[1],
          shm: storage[2],
          capturedAt: this.timestamp(),
          freshness: "storage-observed",
        },
        coverage: {
          storage: "observed",
          structuralRows: "partial",
          archivedPayloads: "opaque",
          semanticOperation: "not-observable",
          editorFreshness: "unknown",
          canonicalTimeline: "unavailable",
        },
      };
      return {
        status: "observed",
        observation,
        issues: [
          "SQLite/WAL/SHM state proves storage observation only; it does not prove the latest in-memory Final Cut edit was flushed.",
          "Undocumented archived payloads remain opaque and are not promoted to Timeline IR or canonicalDocument.read.",
        ],
      };
    } catch (error) {
      return { status: "unavailable", error: unavailable(error) };
    }
  }

  private async fingerprint(path: string, required: boolean): Promise<FinalCutSqliteStorageFingerprint> {
    try {
      const [bytes, metadata] = await Promise.all([this.readFile(path), this.statFile(path)]);
      return {
        path,
        present: true,
        bytes: metadata.size,
        digest: createHash("sha256").update(bytes).digest("hex"),
        modifiedAt: new Date(metadata.mtimeMs).toISOString(),
      };
    } catch (error) {
      if (!required && isMissingFile(error)) return { path, present: false };
      throw new Error(`FINAL_CUT_SQLITE_STORAGE_UNAVAILABLE: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export type FinalCutSqliteRowDelta<T> = {
  added: T[];
  removed: T[];
  modified: Array<{ before: T; after: T }>;
};

export type FinalCutSqliteDeltaStatus = "unchanged" | "changed" | "ambiguous";

export interface FinalCutSqliteWalDelta {
  schemaVersion: typeof FINAL_CUT_SQLITE_WAL_SCHEMA_VERSION;
  status: FinalCutSqliteDeltaStatus;
  canonical: false;
  target: FinalCutSqliteObservationTarget;
  from: { revision: ContextRevision; storage: FinalCutSqliteWalObservation["storage"] };
  to: { revision: ContextRevision; storage: FinalCutSqliteWalObservation["storage"] };
  collections: FinalCutSqliteRowDelta<FinalCutSqliteCollectionRow>;
  metadata: FinalCutSqliteRowDelta<FinalCutSqliteMetadataRow>;
  storage: {
    database: "unchanged" | "changed";
    wal: "absent" | "unchanged" | "changed";
    shm: "absent" | "unchanged" | "changed";
  };
  coverage: Omit<FinalCutSqliteWalObservation["coverage"], "semanticOperation"> & {
    semanticOperation: "not-observable" | "ambiguous";
  };
  recommendation: "no-change-observed" | "canonical-resync-required";
  reasons: string[];
}

export function diffFinalCutSqliteWalObservations(
  previous: FinalCutSqliteWalObservation,
  current: FinalCutSqliteWalObservation,
): FinalCutSqliteWalDelta {
  const reasons: string[] = [];
  const targetMatches = sameTarget(previous.target, current.target)
    && sameTarget(previous.provenance.target, current.provenance.target);
  if (!targetMatches) reasons.push("target identity changed between SQLite observations");
  const provenanceMatches = sameRevision(previous.provenance.framekitRevision, current.provenance.framekitRevision)
    && previous.provenance.artifactDigest === current.provenance.artifactDigest;
  if (!provenanceMatches) reasons.push("Framekit materialization provenance changed between SQLite observations");
  if (previous.finalCutVersion !== current.finalCutVersion) reasons.push("Final Cut version changed");
  if (previous.database.schemaVersion !== current.database.schemaVersion) reasons.push("SQLite schema version changed");
  if (previous.database.sourcePath !== current.database.sourcePath) reasons.push("SQLite source path changed");
  const collections = diffRows(previous.database.collectionRows, current.database.collectionRows);
  const metadata = diffRows(previous.database.metadataRows, current.database.metadataRows);
  if (collections.added.length || collections.removed.length || collections.modified.length) reasons.push("structural collection rows changed");
  if (metadata.added.length || metadata.removed.length || metadata.modified.length) reasons.push("metadata rows changed");
  const storage = {
    database: fingerprintChange(previous.storage.database, current.storage.database),
    wal: optionalFingerprintChange(previous.storage.wal, current.storage.wal),
    shm: optionalFingerprintChange(previous.storage.shm, current.storage.shm),
  };
  if (storage.database === "changed") reasons.push("SQLite database bytes changed");
  if (storage.wal === "changed") reasons.push("SQLite WAL bytes changed");
  if (storage.shm === "changed") reasons.push("SQLite SHM bytes changed");
  const changed = reasons.length > 0;
  const ambiguous = !targetMatches || !provenanceMatches || previous.finalCutVersion !== current.finalCutVersion;
  return {
    schemaVersion: FINAL_CUT_SQLITE_WAL_SCHEMA_VERSION,
    status: ambiguous ? "ambiguous" : changed ? "changed" : "unchanged",
    canonical: false,
    target: current.target,
    from: { revision: previous.database.revision, storage: previous.storage },
    to: { revision: current.database.revision, storage: current.storage },
    collections,
    metadata,
    storage,
    coverage: {
      ...current.coverage,
      semanticOperation: ambiguous || changed ? "ambiguous" : "not-observable",
    },
    recommendation: changed || ambiguous ? "canonical-resync-required" : "no-change-observed",
    reasons: reasons.length > 0 ? reasons : ["no SQLite/WAL/SHM change observed"],
  };
}

export type FinalCutSqliteControlledOperation =
  | "trim-start"
  | "trim-end"
  | "move"
  | "delete"
  | "reorder"
  | "add-existing-source"
  | "repeated-occurrence"
  | "connected-clip"
  | "marker"
  | "project-rename";

export type FinalCutSqliteOperationCoverage = "proven" | "partial" | "ambiguous" | "not-observable";

export interface FinalCutSqliteOperationCapability {
  operation: FinalCutSqliteControlledOperation;
  coverage: FinalCutSqliteOperationCoverage;
  evidence: "fixture-matrix";
  canonical: false;
  reason: string;
}

/** The initial safe matrix intentionally exposes no unproven semantic mappings. */
const FINAL_CUT_SQLITE_CONTROLLED_OPERATIONS: readonly FinalCutSqliteControlledOperation[] = [
  "trim-start", "trim-end", "move", "delete", "reorder", "add-existing-source",
  "repeated-occurrence", "connected-clip", "marker", "project-rename",
];

export const FINAL_CUT_SQLITE_OPERATION_MATRIX: readonly FinalCutSqliteOperationCapability[] = [
  ...FINAL_CUT_SQLITE_CONTROLLED_OPERATIONS,
].map((operation): FinalCutSqliteOperationCapability => ({
  operation,
  coverage: "not-observable",
  evidence: "fixture-matrix",
  canonical: false,
  reason: "No target-version repeated native before/after corpus has proven a semantic SQLite/WAL mapping",
}));

function diffRows<T extends { primaryKey: number }>(before: T[], after: T[]): FinalCutSqliteRowDelta<T> {
  const beforeMap = new Map(before.map((row) => [row.primaryKey, row]));
  const afterMap = new Map(after.map((row) => [row.primaryKey, row]));
  const added: T[] = [];
  const removed: T[] = [];
  const modified: Array<{ before: T; after: T }> = [];
  for (const [key, row] of afterMap) {
    const old = beforeMap.get(key);
    if (!old) added.push(row);
    else if (JSON.stringify(old) !== JSON.stringify(row)) modified.push({ before: old, after: row });
  }
  for (const [key, row] of beforeMap) if (!afterMap.has(key)) removed.push(row);
  return { added, removed, modified };
}

function fingerprintChange(
  before: FinalCutSqliteStorageFingerprint,
  after: FinalCutSqliteStorageFingerprint,
): "unchanged" | "changed" {
  return before.present === after.present && before.digest === after.digest ? "unchanged" : "changed";
}

function optionalFingerprintChange(
  before: FinalCutSqliteStorageFingerprint,
  after: FinalCutSqliteStorageFingerprint,
): "absent" | "unchanged" | "changed" {
  if (!before.present && !after.present) return "absent";
  return fingerprintChange(before, after);
}

function parseTarget(value: FinalCutSqliteObservationTarget): FinalCutSqliteObservationTarget {
  return {
    projectId: nonEmpty(value?.projectId, "target.projectId"),
    sequenceId: nonEmpty(value?.sequenceId, "target.sequenceId"),
  };
}

function parseProvenance(
  value: FinalCutSqliteMaterializationProvenance,
  target: FinalCutSqliteObservationTarget,
): FinalCutSqliteMaterializationProvenance {
  const artifactDigest = nonEmpty(value?.artifactDigest, "provenance.artifactDigest");
  if (!value?.framekitRevision || typeof value.framekitRevision.id !== "string"
    || !Number.isSafeInteger(value.framekitRevision.sequence) || typeof value.framekitRevision.timestamp !== "string") {
    throw new Error("FINAL_CUT_SQLITE_PROVENANCE_INVALID: framekit revision is incomplete");
  }
  const provenanceTarget = parseTarget(value.target);
  if (!sameTarget(target, provenanceTarget)) {
    throw new Error("FINAL_CUT_SQLITE_TARGET_MISMATCH: capture target and provenance target differ");
  }
  return {
    framekitRevision: { ...value.framekitRevision },
    artifactDigest,
    target: provenanceTarget,
  };
}

function inspectionFailure(inspection: Exclude<FinalCutSqliteInspectionResult, { status: "partial" }>): FinalCutSqliteWalObservationResult {
  return { status: inspection.status, error: inspection.error };
}

function unavailable(error: unknown): { code: "FINAL_CUT_SQLITE_WAL_UNAVAILABLE"; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "FINAL_CUT_SQLITE_WAL_UNAVAILABLE",
    message,
    retryable: /busy|locked|timed out|timeout|temporar|unavailable/i.test(message),
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function nonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`FINAL_CUT_SQLITE_INPUT_INVALID: ${name} is required`);
  return value.trim();
}

function sameTarget(left: FinalCutSqliteObservationTarget, right: FinalCutSqliteObservationTarget): boolean {
  return left.projectId === right.projectId && left.sequenceId === right.sequenceId;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}
