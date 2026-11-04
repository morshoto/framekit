/**
 * Experimental subprocess fixture. This is not a production coordinator,
 * authenticated journal, native receiver, or reservation recovery mechanism.
 * Callers must supply a disposable, isolated directory and synthetic identity.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export interface SenderFixtureBinding {
  reservationId: string;
  reservationVersion: 3 | 4;
  route: "publish" | "materialization";
  owner: string;
  executionId: string;
}
export interface SenderFixtureObservation {
  status: "active-or-interrupted" | "abort-requested" | "sender-settled" | "unknown";
  nativeQuiescence: "unproven";
  recoveryEligibility: "unavailable";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const unknown = (): SenderFixtureObservation => ({ status: "unknown", nativeQuiescence: "unproven", recoveryEligibility: "unavailable" });
function valid(b: SenderFixtureBinding): boolean {
  return !!b && hash.test(b.reservationId) && (b.reservationVersion === 3 || b.reservationVersion === 4)
    && (b.route === "publish" || b.route === "materialization") && uuid.test(b.owner) && uuid.test(b.executionId);
}
function pathFor(directory: string, b: SenderFixtureBinding, kind: string): string {
  return join(directory, `${b.reservationId}.sender-${kind}`);
}
function record(b: SenderFixtureBinding, phase: "start" | "abort" | "settled") {
  return { schemaVersion: 1, ...b, phase };
}
async function readRecord(path: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("invalid fixture marker");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}
function matches(value: unknown, b: SenderFixtureBinding, phase: "start" | "abort" | "settled"): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj.schemaVersion === 1 && obj.phase === phase && obj.reservationId === b.reservationId
    && obj.reservationVersion === b.reservationVersion && obj.route === b.route && obj.owner === b.owner && obj.executionId === b.executionId;
}
async function writeMarker(directory: string, b: SenderFixtureBinding, phase: "start" | "abort" | "settled") {
  const handle = await open(pathFor(directory, b, phase), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record(b, phase)) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Read untrusted fixture markers; sender settlement never proves receiver state. */
export async function inspectSenderFixture(directory: string, b: SenderFixtureBinding, hooks?: { beforeRecheck?: () => Promise<void> }): Promise<SenderFixtureObservation> {
  try {
    if (!valid(b)) return unknown();
    const start = await readRecord(pathFor(directory, b, "start"));
    const abort = await readRecord(pathFor(directory, b, "abort"));
    const settled = await readRecord(pathFor(directory, b, "settled"));
    if (!matches(start, b, "start") || (abort !== undefined && !matches(abort, b, "abort"))
      || (settled !== undefined && !matches(settled, b, "settled"))) return unknown();
    await hooks?.beforeRecheck?.();
    const again = await Promise.all(["start", "abort", "settled"].map(phase => readRecord(pathFor(directory, b, phase))));
    if (JSON.stringify([start, abort, settled]) !== JSON.stringify(again)) return unknown();
    return { status: settled !== undefined ? "sender-settled" : abort !== undefined ? "abort-requested" : "active-or-interrupted",
      nativeQuiescence: "unproven", recoveryEligibility: "unavailable" };
  } catch { return unknown(); }
}

/**
 * Start a disposable fixture child only after an exclusive, durable marker.
 * It deliberately has no production callers and never changes a reservation.
 * PID is not persisted or used as evidence; markers are not authenticated.
 */
export async function startSenderFixture(directory: string, input: SenderFixtureBinding, options: {
  command: string; args: string[]; timeoutMs?: number; killAfterMs?: number;
}): Promise<{ child: ChildProcessWithoutNullStreams; abort(): Promise<void>; closed: Promise<void>; localStatus(): "active" | "abort-requested" | "sender-settled" | "unknown" }> {
  const b = structuredClone(input);
  if (!valid(b)) throw new Error("SENDER_FIXTURE_INVALID_BINDING");
  await writeMarker(directory, b, "start");
  const child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let localState: "active" | "abort-requested" | "sender-settled" | "unknown" = "unknown";
  let exited = false;
  child.once("spawn", () => { if (!closed && !exited) localState = "active"; });
  child.once("exit", () => { exited = true; localState = "unknown"; });
  let abortPromise: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const abort = (): Promise<void> => {
    if (closed || exited || child.pid === undefined) return Promise.resolve();
    if (!abortPromise) abortPromise = (async () => {
      try {
        if (!matches(await readRecord(pathFor(directory, b, "start")), b, "start")) throw new Error("SENDER_FIXTURE_OWNER_MISMATCH");
        await writeMarker(directory, b, "abort");
        localState = "abort-requested";
      } finally {
        if (!closed && !exited) {
          child.kill("SIGTERM");
          forceKill = setTimeout(() => { if (!closed && !exited) child.kill("SIGKILL"); }, options.killAfterMs ?? 1000);
        }
      }
    })();
    return abortPromise;
  };
  const completion = new Promise<void>((resolve) => {
    child.once("error", () => {});
    child.once("close", () => {
      closed = true;
      localState = "unknown";
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      void (async () => {
        try {
          if (abortPromise) await abortPromise;
          if (child.pid !== undefined && matches(await readRecord(pathFor(directory, b, "start")), b, "start")) {
            await writeMarker(directory, b, "settled");
            localState = "sender-settled";
          }
        } catch { /* Partial or conflicting fixture evidence remains unresolved. */ }
      })().finally(resolve);
    });
  });
  if (options.timeoutMs !== undefined) timeout = setTimeout(() => { void abort().catch(() => {}); }, options.timeoutMs);
  return { child, abort, closed: completion, localStatus: () => localState };
}
