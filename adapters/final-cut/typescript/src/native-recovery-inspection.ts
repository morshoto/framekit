import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Requested evidence only: none of these fields establishes dispatch or quiescence. */
export interface NativeMaterializationRecoveryContext {
  kind: "materialization";
  jobId: string;
  dispatchId: string;
  requestedTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
  artifactDigest: string;
  desiredDigest: string;
  executorIdentity: null;
  nativeQuiescence: "unproven";
}

/** Requested library only; it is not a verified native target. */
export interface NativePublishRecoveryContext {
  kind: "publish";
  jobId: string;
  dispatchId: string;
  requestedTarget: { libraryPath: string };
  artifactDigest: string;
  executorIdentity: null;
  nativeQuiescence: "unproven";
}

/** A planned receiver identity and target, not proof that dispatch or completion occurred. */
export type RecoverableNativeContext = (Omit<NativeMaterializationRecoveryContext, "executorIdentity"> | Omit<NativePublishRecoveryContext, "executorIdentity">) & {
  executorIdentity: string;
  dispatchState: "intent";
  canonicalTarget: Record<string, string>;
  expectedCanonicalDigest: string;
  expectedRestoreDigest?: string;
};

export type NativeRecoveryContext = NativeMaterializationRecoveryContext | NativePublishRecoveryContext | RecoverableNativeContext;

function validPublishContext(value: unknown, operation: string): value is NativePublishRecoveryContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Partial<NativePublishRecoveryContext>;
  const path = c.requestedTarget?.libraryPath;
  return c.kind === "publish"
    && typeof c.jobId === "string" && /^publish-job-[a-z0-9-]{1,80}$/.test(c.jobId)
    && operation === `native.publish.${createHash("sha256").update(c.jobId).digest("hex")}`
    && typeof c.dispatchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.dispatchId)
    && typeof path === "string" && path.length <= 4096 && isAbsolute(path) && path.endsWith(".fcpbundle")
    && typeof c.artifactDigest === "string" && /^[a-f0-9]{64}$/.test(c.artifactDigest)
    && c.executorIdentity === null && c.nativeQuiescence === "unproven";
}

export function validRecoveryContext(value: unknown, operation: string): value is NativeMaterializationRecoveryContext | NativePublishRecoveryContext {
  return validMaterializationContext(value, operation) || validPublishContext(value, operation);
}

function validRecoverableContext(value: unknown, operation: string): value is RecoverableNativeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as RecoverableNativeContext;
  if (typeof c.executorIdentity !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(c.executorIdentity)
    || c.dispatchState !== "intent" || !/^[a-f0-9]{64}$/.test(c.expectedCanonicalDigest)
    || (c.expectedRestoreDigest !== undefined && !/^[a-f0-9]{64}$/.test(c.expectedRestoreDigest))
    || !validRecoveryContext({ ...c, executorIdentity: null }, operation)) return false;
  const t = c.canonicalTarget;
  if (!t || typeof t !== "object" || Array.isArray(t)) return false;
  const keys = c.kind === "publish" ? ["libraryPath", "projectUid", "sequenceUid"] : ["libraryUid", "eventUid", "projectUid", "sequenceUid"];
  if (Object.keys(t).length !== keys.length || !keys.every((key) => typeof t[key] === "string" && t[key].trim().length > 0 && t[key].length <= 1024)) return false;
  if (c.kind === "publish") return t.libraryPath === c.requestedTarget.libraryPath;
  return keys.every((key) => t[key] === (c.requestedTarget as Record<string, string>)[key])
    && c.expectedCanonicalDigest === c.desiredDigest;
}

function validMaterializationContext(value: unknown, operation: string): value is NativeMaterializationRecoveryContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Partial<NativeMaterializationRecoveryContext>;
  const t = c.requestedTarget;
  return c.kind === "materialization"
    && typeof c.jobId === "string" && /^materialization-[a-z0-9-]{1,80}$/.test(c.jobId)
    && operation === `native.materialize.${createHash("sha256").update(c.jobId).digest("hex")}`
    && typeof c.dispatchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.dispatchId)
    && Boolean(t && [t.libraryUid, t.eventUid, t.projectUid, t.sequenceUid].every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 1024))
    && typeof c.artifactDigest === "string" && /^[a-f0-9]{64}$/.test(c.artifactDigest)
    && typeof c.desiredDigest === "string" && /^[a-f0-9]{64}$/.test(c.desiredDigest)
    && c.executorIdentity === null && c.nativeQuiescence === "unproven";
}

/** Observational evidence, never an authorization to recover or dispatch. */
export interface NativeRecoveryInspection {
  status: "clear" | "recovery-required" | "unknown";
  nativeQuiescence: "unproven";
  recoveryEligibility: "unavailable";
  sender: { status: "untracked" | "active-or-interrupted" | "sender-settled" | "unknown" };
  reservation?: { version: 2 | 3 | 4; reservationId: string; operation: string; jobId?: string; dispatchId?: string; jobCorrelation?: "unverified" };
  dispatchState?: "possibly-dispatched";
  missingEvidence?: ["receiver-terminal-quiescence", "independent-target-outcome", "legacy-writer-exclusion"];
  safeNextActions?: ["inspect", "retain-reservation"];
  intent?: { requestedTarget: NativeRecoveryContext["requestedTarget"]; artifactDigest: string; desiredDigest?: string };
}

const unknown = (): NativeRecoveryInspection => ({ status: "unknown", nativeQuiescence: "unproven", recoveryEligibility: "unavailable", sender: { status: "unknown" } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read a bounded regular file, refusing symlinks, replacement and in-place changes. */
async function readStable(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16_384) throw new Error("invalid evidence file");
    const data = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || data.length !== after.size) throw new Error("evidence changed");
    return data.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function readSettlement(path: string, id: string): Promise<string | undefined> {
  const directory = `${path}.sender-settled`;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid sender directory");
    return await readStable(join(directory, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function markerMatches(raw: string, reservationId: string): boolean {
  try {
    const value = JSON.parse(raw) as { reservationId?: unknown; owner?: unknown };
    return value !== null && value.reservationId === reservationId && typeof value.owner === "string" && uuid.test(value.owner);
  } catch { return false; }
}

/**
 * Read-only, point-in-time observation; old writers do not share a lock, so even
 * repeated reads cannot exclude concurrent changes or establish quiescence.
 */
export async function inspectNativeRecoveryReadOnly(path: string): Promise<NativeRecoveryInspection> {
  try {
    if (await exists(`${path}.lock`)) return unknown();
    const contents = await readStable(path);
    const active = await readStable(`${path}.active`);
    if (contents === undefined) {
      if (active !== undefined || await exists(`${path}.lock`) || await readStable(path) !== undefined || await readStable(`${path}.active`) !== undefined) return unknown();
      return { status: "clear", nativeQuiescence: "unproven", recoveryEligibility: "unavailable", sender: { status: "unknown" } };
    }
    const record = JSON.parse(contents) as Record<string, unknown>;
    if (!record || typeof record !== "object" || Array.isArray(record) || ![2, 3, 4].includes(record.version as number)
      || record.kind !== "native-operation" || typeof record.owner !== "string" || !uuid.test(record.owner)
      || typeof record.operation !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(record.operation)) return unknown();
    if (record.version === 3 && !validRecoveryContext(record.recoveryContext, record.operation)) return unknown();
    if (record.version === 4 && !validRecoverableContext(record.recoveryContext, record.operation)) return unknown();
    if (record.senderTracked !== undefined && typeof record.senderTracked !== "boolean") return unknown();
    const reservationId = createHash("sha256").update(contents).digest("hex");
    const settled = await readSettlement(path, reservationId);
    const sender = record.senderTracked !== true ? (active !== undefined || settled !== undefined ? "unknown" : "untracked")
      : active !== undefined ? (settled === undefined && markerMatches(active, reservationId) ? "active-or-interrupted" : "unknown")
        : settled !== undefined && markerMatches(settled, reservationId) ? "sender-settled" : "unknown";
    if (await exists(`${path}.lock`) || await readStable(path) !== contents || await readStable(`${path}.active`) !== active
      || await readSettlement(path, reservationId) !== settled) return unknown();
    const context = record.version === 3 || record.version === 4 ? record.recoveryContext as NativeRecoveryContext : undefined;
    return { status: "recovery-required", nativeQuiescence: "unproven", recoveryEligibility: "unavailable", sender: { status: sender },
      dispatchState: "possibly-dispatched", missingEvidence: ["receiver-terminal-quiescence", "independent-target-outcome", "legacy-writer-exclusion"],
      safeNextActions: ["inspect", "retain-reservation"],
      ...(context ? { intent: { requestedTarget: context.requestedTarget, artifactDigest: context.artifactDigest,
        ...(context.kind === "materialization" ? { desiredDigest: context.desiredDigest } : {}) } } : {}),
      reservation: { version: record.version as 2 | 3 | 4, reservationId, operation: record.operation,
        ...(context ? { jobId: context.jobId, dispatchId: context.dispatchId, jobCorrelation: "unverified" as const } : {}) } };
  } catch { return unknown(); }
}
