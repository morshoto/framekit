import { inspectRun, type QaRunManifest } from "./run-store.js";

const states = ["awaiting-confirmation", "awaiting-final-cut", "verification-pending", "verified", "failed"] as const;
type PublisherState = typeof states[number];
type CallStatus = (name: "artifact.publish.status", args: { jobId: string }, options: { signal: AbortSignal }) => Promise<unknown>;

/** Observe a recorded publisher job without executing, retrying, or releasing anything. */
export async function inspectQaPublisher(root: string, qaRunId: string, callStatus: CallStatus, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("QA_STATUS_TIMEOUT_INVALID");
  const run = await inspectRun(root, qaRunId);
  const base = { tier: "publisher-status" as const, dispatch: run.dispatch, verdict: "BLOCKED" as const,
    nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
  if (run.dispatch === "NOT_DISPATCHED") return { ...base, nextAction: "inspect-run" as const };
  if (!run.publishJobId) return { ...base, nextAction: "job-id-unavailable" as const };
  const jobId = run.publishJobId;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let value: unknown;
  let unavailable = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    });
    value = structuredClone(await Promise.race([callStatus("artifact.publish.status", { jobId }, { signal: controller.signal }), timeout]));
  } catch { unavailable = true; }
  finally { if (timer) clearTimeout(timer); }
  const current = await inspectRun(root, qaRunId);
  const fields = Object.keys(run.manifest) as Array<keyof QaRunManifest>;
  if (fields.some(key => current.manifest[key] !== run.manifest[key]) || current.dispatch !== run.dispatch
    || current.publishJobId !== jobId || current.authorizationBinding !== run.authorizationBinding) throw new Error("QA_PUBLISH_STATUS_IDENTITY_MISMATCH");
  if (unavailable || !value || typeof value !== "object" || Array.isArray(value)) return { ...base, nextAction: "status-unavailable" as const };
  const item = value as Record<string, unknown>;
  if (item.jobId !== jobId) throw new Error("QA_PUBLISH_STATUS_IDENTITY_MISMATCH");
  if (!states.includes(item.state as PublisherState)) return { ...base, nextAction: "status-unavailable" as const };
  return { ...base, jobId, observedState: item.state as PublisherState, nextAction: "inspect-recovery" as const };
}
