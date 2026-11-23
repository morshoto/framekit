import { inspectRun } from "./run-store.js";

const states = ["awaiting-confirmation", "awaiting-final-cut", "verification-pending", "verified", "failed"] as const;
type PublisherState = typeof states[number];
type CallStatus = (name: "artifact.publish.status", args: { jobId: string }) => Promise<unknown>;

/** Observe a recorded publisher job without executing, retrying, or releasing anything. */
export async function inspectQaPublisher(root: string, qaRunId: string, callStatus: CallStatus) {
  const run = await inspectRun(root, qaRunId);
  const base = { tier: "publisher-status" as const, dispatch: run.dispatch, verdict: "BLOCKED" as const,
    nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
  if (run.dispatch === "NOT_DISPATCHED") return { ...base, nextAction: "inspect-run" as const };
  if (!run.publishJobId) return { ...base, nextAction: "job-id-unavailable" as const };
  let value: unknown;
  try { value = structuredClone(await callStatus("artifact.publish.status", { jobId: run.publishJobId })); }
  catch { return { ...base, nextAction: "status-unavailable" as const }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...base, nextAction: "status-unavailable" as const };
  const item = value as Record<string, unknown>;
  if (item.jobId !== run.publishJobId) throw new Error("QA_PUBLISH_STATUS_IDENTITY_MISMATCH");
  if (!states.includes(item.state as PublisherState)) return { ...base, nextAction: "status-unavailable" as const };
  return { ...base, jobId: run.publishJobId, observedState: item.state as PublisherState, nextAction: "inspect-recovery" as const };
}
