import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { FinalCutProjectPublishJob, FinalCutProjectPublishResult, FinalCutProjectPublishDelivery, FinalCutProjectPublishJobState } from "../../adapters/final-cut/typescript/src/publisher.js";

type PersistedPublishJob = { version: 1; job: FinalCutProjectPublishJob; runtime?: { importAttempted?: boolean; delivery?: FinalCutProjectPublishDelivery } };

function normalizePersistedPublishJob(value: unknown, filename: string): PersistedPublishJob {
  const persisted = value as PersistedPublishJob | undefined;
  const job = persisted?.job;
  const validStates: FinalCutProjectPublishJobState[] = ["awaiting-confirmation", "awaiting-final-cut", "verification-pending", "verified", "failed"];
  if (!persisted || persisted.version !== 1 || !job || typeof job.jobId !== "string"
    || !/^publish-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.jobId)
    || !validStates.includes(job.state) || filename !== `${job.jobId}.json` || !job.handoff || typeof job.handoff !== "object") {
    throw new Error("PUBLISH_JOB_STORE_INVALID: invalid publish job record");
  }
  if (job.state === "verification-pending" && !persisted.runtime) throw new Error("PUBLISH_JOB_STORE_INVALID: pending job is missing recovery state");
  if (persisted.runtime?.importAttempted === true && job.state !== "verification-pending" && job.state !== "verified") throw new Error("PUBLISH_JOB_STORE_INVALID: spent import has a re-dispatchable state");
  if (job.state === "verified" && !isVerifiedPublishJob(job, job.jobId)) throw new Error("PUBLISH_JOB_STORE_INVALID: verified job is missing consistent native target proof");
  job.handoff.route ??= "background-document-open";
  if (job.handoff.route !== "background-document-open" && job.handoff.route !== "headed-apple-event") throw new Error("PUBLISH_JOB_STORE_INVALID: invalid publish route");
  if (!job.delivery && persisted.runtime?.delivery) job.delivery = structuredClone(persisted.runtime.delivery);
  return persisted;
}

/** Read a stored job status without constructing a publisher or changing the store. */
export async function readPersistedFinalCutPublishJobStatus(directory: string, jobId: string, signal?: AbortSignal): Promise<{ jobId: string; state: FinalCutProjectPublishJobState; artifactDigest: string }> {
  if (!isAbsolute(directory) || !/^publish-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new Error("PUBLISH_JOB_STORE_INVALID");
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("PUBLISH_JOB_STORE_INVALID");
  const modern = `${jobId}.json`;
  const legacy = `${createHash("sha256").update(jobId).digest("hex")}.json`;
  let filename = modern;
  let initial;
  try { initial = await lstat(join(directory, filename), { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    filename = legacy;
    initial = await lstat(join(directory, filename), { bigint: true });
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 64n * 1024n * 1024n || signal?.aborted) throw new Error("PUBLISH_JOB_STORE_INVALID");
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size || before.mtimeNs !== initial.mtimeNs || before.ctimeNs !== initial.ctimeNs) throw new Error("PUBLISH_JOB_STORE_INVALID");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("PUBLISH_JOB_STORE_INVALID");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > 64 * 1024 * 1024) throw new Error("PUBLISH_JOB_STORE_INVALID");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(join(directory, filename), { bigint: true });
    if (BigInt(total) !== before.size || [after, current].some(item => !item.isFile() || item.isSymbolicLink() || item.dev !== before.dev || item.ino !== before.ino || item.size !== before.size || item.mtimeNs !== before.mtimeNs || item.ctimeNs !== before.ctimeNs) || signal?.aborted) throw new Error("PUBLISH_JOB_STORE_INVALID");
    text = Buffer.concat(chunks).toString("utf8");
  } finally { await file.close(); }
  const value: unknown = JSON.parse(text);
  if (filename === legacy) {
    if (!isVerifiedPublishJob(value, jobId) || !/^[a-f0-9]{64}$/.test(value.artifactDigest ?? "")) throw new Error("PUBLISH_JOB_STORE_INVALID");
    return { jobId, state: value.state, artifactDigest: value.artifactDigest };
  }
  const record = normalizePersistedPublishJob(value, filename);
  if (!/^[a-f0-9]{64}$/.test(record.job.artifactDigest ?? "")) throw new Error("PUBLISH_JOB_STORE_INVALID");
  return { jobId: record.job.jobId, state: record.job.state, artifactDigest: record.job.artifactDigest };
}


function isVerifiedPublishJob(value: unknown, jobId: string): value is FinalCutProjectPublishJob {
  if (!value || typeof value !== "object") return false;
  const job = value as FinalCutProjectPublishJob;
  return job.jobId === jobId
    && job.state === "verified"
    && job.result?.verified === true
    && sameNativeTargetIdentity(job.createdTarget, job.result.createdTarget);
}

function sameNativeTargetIdentity(
  left: FinalCutProjectPublishResult["createdTarget"] | undefined,
  right: FinalCutProjectPublishResult["createdTarget"] | undefined,
): boolean {
  if (!hasStableNativeTargetIds(left) || !hasStableNativeTargetIds(right)) return false;
  return left.kind === right.kind
    && left.projectId === right.projectId
    && left.sequenceId === right.sequenceId
    && left.libraryId === right.libraryId
    && left.eventId === right.eventId;
}

function hasStableNativeTargetIds(
  value: FinalCutProjectPublishResult["createdTarget"] | undefined,
): value is FinalCutProjectPublishResult["createdTarget"] {
  return value?.kind === "editor.project"
    && typeof value.projectId === "string"
    && value.projectId.trim().length > 0
    && typeof value.sequenceId === "string"
    && value.sequenceId.trim().length > 0
    && (value.libraryId === undefined || (typeof value.libraryId === "string" && value.libraryId.trim().length > 0))
    && (value.eventId === undefined || (typeof value.eventId === "string" && value.eventId.trim().length > 0));
}
