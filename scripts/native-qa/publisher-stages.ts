import { join } from "node:path";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

export type PublisherStage = "prepared" | "dispatched" | "dispatch-unconfirmed" | "verified" | "verification-recovery-required";
interface StageRecord { schemaVersion: 1; index: number; stage: PublisherStage; jobId: string; artifactDigest: string; observedAt: string; recordedAt: string; clockAdjusted: boolean }
const stages: PublisherStage[] = ["prepared", "dispatched", "dispatch-unconfirmed", "verified", "verification-recovery-required"];

/** Read historical publisher responses only; a provider response is not independent native proof. */
export async function readQaPublisherStages(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, run.manifest);
  const records: StageRecord[] = [];
  let missing = false;
  for (let index = 1; index <= 3; index++) {
    let value: unknown;
    try { value = JSON.parse(await readQaRecord(join(root, qaRunId, `publisher-stage-${index}.json`))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; continue; }
      throw new Error("QA_STAGE_CORRUPT");
    }
    if (missing || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_STAGE_CORRUPT");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "artifactDigest,clockAdjusted,index,jobId,observedAt,recordedAt,schemaVersion,stage"
      || item.schemaVersion !== 1 || item.index !== index || !stages.includes(item.stage as PublisherStage)
      || typeof item.jobId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(item.jobId)
      || item.artifactDigest !== run.manifest.artifactDigest || typeof item.recordedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.recordedAt)
      || !Number.isFinite(Date.parse(item.recordedAt)) || new Date(item.recordedAt).toISOString() !== item.recordedAt
      || typeof item.observedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.observedAt)
      || !Number.isFinite(Date.parse(item.observedAt)) || new Date(item.observedAt).toISOString() !== item.observedAt
      || typeof item.clockAdjusted !== "boolean" || item.observedAt > item.recordedAt || item.clockAdjusted !== (item.observedAt !== item.recordedAt)
      || (index === 1 && item.stage !== "prepared")
      || (index === 1 && run.dispatch === "UNKNOWN_AFTER_DISPATCH" && run.publishJobId !== undefined && run.publishJobId !== item.jobId)
      || (index === 2 && item.stage !== "dispatched" && item.stage !== "dispatch-unconfirmed")
      || (index === 3 && (records[1]?.stage !== "dispatched" || (item.stage !== "verified" && item.stage !== "verification-recovery-required")))
      || (index > 1 && (item.jobId !== records[0]?.jobId || item.recordedAt < records[index - 2]!.recordedAt
        || run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || run.publishJobId !== item.jobId))) throw new Error("QA_STAGE_CORRUPT");
    records.push(item as unknown as StageRecord);
  }
  return { stages: records, scope: "publisher-response-observation" as const, dispatch: run.dispatch,
    verdict: "BLOCKED" as const, nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
}

/** Persist a sanitized, ordered callback observation; it does not authorize or initiate dispatch. */
export async function recordQaPublisherStage(root: string, qaRunId: string, stage: PublisherStage, snapshot: unknown, clock = Date.now): Promise<void> {
  const run = await inspectRun(root, qaRunId);
  const history = await readQaPublisherStages(root, qaRunId);
  const previous = history.stages;
  const value = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  let jobId: string;
  if (stage === "prepared" && previous.length === 0 && run.dispatch === "NOT_DISPATCHED") {
    if (typeof value.jobId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.jobId)
      || value.state !== "awaiting-confirmation" || value.artifactDigest !== run.manifest.artifactDigest) throw new Error("QA_STAGE_OBSERVATION_INVALID");
    jobId = value.jobId;
  } else {
    jobId = previous[0]?.jobId ?? "";
    if (!jobId || run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || run.publishJobId !== jobId) throw new Error("QA_STAGE_SEQUENCE_INVALID");
    if (previous.length === 1 && stage === "dispatch-unconfirmed") { /* Response identity is not trusted. */ }
    else if (previous.length === 1 && stage === "dispatched") {
      const delivery = value.delivery as Record<string, unknown> | undefined;
      if (value.jobId !== jobId || value.state !== "verification-pending" || value.nextAction !== "confirm-verification" || delivery?.status !== "dispatched") throw new Error("QA_STAGE_OBSERVATION_INVALID");
    } else if (previous.length === 2 && previous[1]?.stage === "dispatched" && (stage === "verified" || stage === "verification-recovery-required")) {
      const result = value.result as Record<string, unknown> | undefined;
      if (value.jobId !== jobId || value.state !== "verified" || result?.verified !== true
        || (stage === "verification-recovery-required" && !value.recoveryReservation)) throw new Error("QA_STAGE_OBSERVATION_INVALID");
    } else throw new Error("QA_STAGE_SEQUENCE_INVALID");
  }
  const now = clock();
  if (!Number.isFinite(now)) throw new Error("QA_STAGE_CLOCK_INVALID");
  let observedAt: string; let recordedAt: string;
  try {
    observedAt = new Date(now).toISOString();
    recordedAt = new Date(Math.max(now, previous.length ? Date.parse(previous[previous.length - 1]!.recordedAt) : now)).toISOString();
  }
  catch { throw new Error("QA_STAGE_CLOCK_INVALID"); }
  const current = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, current.manifest);
  if (JSON.stringify(current) !== JSON.stringify(run)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  const record: StageRecord = { schemaVersion: 1, index: previous.length + 1, stage, jobId, artifactDigest: run.manifest.artifactDigest, observedAt, recordedAt, clockAdjusted: observedAt !== recordedAt };
  try { await publishQaRecord(join(root, qaRunId, `publisher-stage-${record.index}.json`), `${JSON.stringify(record)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("QA_STAGE_SEQUENCE_INVALID"); throw error; }
  await readQaPublisherStages(root, qaRunId);
}
