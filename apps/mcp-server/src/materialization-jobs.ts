import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { timelineIrDigest, validateTimelineIr, type TimelineIr } from "@framekit/runtime";
import {
  compileTimelineIrToFcpxml,
  type TimelineIrMaterializationCoverage,
  type TimelineIrMaterializationProvenance,
  type TimelineIrToFcpxmlResult,
  type TimelineIrToFcpxmlTarget,
} from "@framekit/final-cut";
import { EditingSessionRepository } from "./headless-sessions.js";

export interface SessionMaterializationPublishRequest {
  jobId: string;
  artifactPath: string;
  artifactDigest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  collisionPolicy: "create-only";
  desired: TimelineIr;
  desiredDigest: string;
  baseDigest: string;
  baseRevision: TimelineIr["revision"];
  coverage: TimelineIrMaterializationCoverage;
  provenance: TimelineIrMaterializationProvenance;
}

export type MaterializationVerificationTier = "artifact" | "delivery" | "storage-observed" | "canonical-verified" | "interaction-required";

export type MaterializationDeliveryState = "background" | "activated" | "prompted" | "failed" | "interaction-required";

export interface MaterializationDeliveryEvidence {
  state: MaterializationDeliveryState;
  route: "background" | "headed" | "unknown";
}

export interface MaterializationStructuralDiff {
  target: { projectId: string; sequenceId: string };
  desiredDigest: string;
  actualDigest: string;
  changes: Array<{ path: string; before?: unknown; after?: unknown }>;
}

export interface MaterializationVerification {
  tier: MaterializationVerificationTier;
  status: "verified" | "blocked" | "failed";
  artifactDigest: string;
  desiredDigest: string;
  reason?: string;
  canonicalReadbackDigest?: string;
  canonicalTarget?: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
  structuralDiff?: MaterializationStructuralDiff;
  delivery?: MaterializationDeliveryEvidence;
}

export interface SessionMaterializationPublisher {
  readCanonicalTarget?(request: {
    target: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
  }): Promise<{
    canonicalReadback: TimelineIr;
    canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
    delivery?: MaterializationDeliveryEvidence;
  }>;
  publish(request: SessionMaterializationPublishRequest): Promise<
    | {
        state: "completed";
        canonicalReadback: TimelineIr;
        canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
        headedNativeVerified: boolean;
        delivery?: MaterializationDeliveryEvidence;
      }
    | { state: "blocked"; code: string; message: string; retryable: boolean; delivery?: MaterializationDeliveryEvidence }
  >;
}

export interface SessionMaterializationJob {
  schemaVersion: 1 | 2;
  jobId: string;
  sessionId: string;
  state: "blocked" | "publishing" | "completed" | "failed";
  nextAction: "retry" | "status" | "none";
  artifactPath: string;
  artifactDigest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  desired: TimelineIr;
  desiredDigest: string;
  baseDigest: string;
  baseRevision: TimelineIr["revision"];
  coverage?: TimelineIrMaterializationCoverage;
  provenance?: TimelineIrMaterializationProvenance;
  verification?: MaterializationVerification;
  continuation?: {
    state: "canonical-resync-required" | "resynced";
    reason: string;
    sessionId?: string;
    readbackDigest?: string;
    changeSinceHandoff?: "changed" | "unchanged" | "unknown";
    delivery?: MaterializationDeliveryEvidence;
  };
  sessionDigest: string;
  claim?: { id: string; claimedAt: string };
  evidence: {
    artifact: { verified: true; format: "fcpxml"; digest: string };
    providerRequested: boolean;
    canonicalReadback: boolean;
    headedNative: boolean;
  };
  error?: { code: string; message: string; retryable: boolean };
}

export class SessionMaterializationJobs {
  public constructor(
    private readonly directory: string,
    private readonly sessions: EditingSessionRepository,
    private readonly publisher?: SessionMaterializationPublisher,
  ) {}

  public async preview(sessionId: string, target: TimelineIrToFcpxmlTarget) {
    const session = await this.sessions.loadForMaterialization(sessionId);
    this.assertProvider(session.document().provider?.id, target.provider);
    session.assertMaterializationReady(session.base().revision);
    const artifact = compileTimelineIrToFcxmlVersioned(session.desired(), target);
    return {
      sessionId,
      mutating: false,
      sessionState: session.state(),
      target: artifact.target,
      destination: artifact.destination,
      collisionPolicy: "create-only",
      artifactDigest: artifact.digest,
      coverage: artifact.coverage,
      provenance: artifact.provenance,
      evidence: { artifact: { verified: true, format: "fcpxml" as const, digest: artifact.digest } },
    };
  }

  public async execute(sessionId: string, target: TimelineIrToFcpxmlTarget, confirm: boolean): Promise<SessionMaterializationJob> {
    if (!confirm) throw new Error("MATERIALIZATION_CONFIRMATION_REQUIRED: set confirm=true to stage and publish a versioned project");
    const session = await this.sessions.loadForMaterialization(sessionId);
    this.assertProvider(session.document().provider?.id, target.provider);
    session.assertMaterializationReady(session.base().revision);
    const desired = session.desired();
    const artifact = compileTimelineIrToFcxmlVersioned(desired, target);
    const jobId = `materialization-${randomUUID()}`;
    const artifactPath = join(this.directory, "artifacts", `${jobId}.fcpxml`);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, artifact.xml, { encoding: "utf8", flag: "wx" });

    session.markWaitingForMaterialization();
    await this.sessions.checkpoint(sessionId, session);

    let job: SessionMaterializationJob = {
      schemaVersion: 2,
      jobId,
      sessionId,
      state: "blocked",
      nextAction: "retry",
      artifactPath,
      artifactDigest: artifact.digest,
      target: artifact.target,
      destination: artifact.destination,
      desired: structuredClone(desired),
      desiredDigest: timelineIrDigest(desired),
      baseDigest: timelineIrDigest(session.base()),
      baseRevision: structuredClone(session.base().revision),
      coverage: artifact.coverage,
      provenance: artifact.provenance,
      sessionDigest: digestSession(session),
      evidence: {
        artifact: { verified: true, format: "fcpxml", digest: artifact.digest },
        providerRequested: false,
        canonicalReadback: false,
        headedNative: false,
      },
      verification: {
        tier: "artifact",
        status: "blocked",
        artifactDigest: artifact.digest,
        desiredDigest: timelineIrDigest(desired),
        reason: "No Final Cut materialization publisher is configured; retry when a provider is available",
      },
      error: {
        code: "MATERIALIZATION_PROVIDER_UNAVAILABLE",
        message: "No Final Cut materialization publisher is configured; retry when a provider is available",
        retryable: true,
      },
    };
    await this.save(job);
    return this.attempt(job);
  }

  public async status(jobId: string): Promise<SessionMaterializationJob> {
    try {
      const job = JSON.parse(await readFile(this.jobPath(jobId), "utf8")) as SessionMaterializationJob;
      if (job.jobId !== jobId || (job.schemaVersion !== 1 && job.schemaVersion !== 2)) {
        throw new Error("MATERIALIZATION_JOB_INVALID: persisted job is invalid");
      }
      return structuredClone(normalizePersistedJob(job));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`MATERIALIZATION_JOB_NOT_FOUND: unknown materialization job ${jobId}`);
      }
      throw error;
    }
  }

  public async retry(jobId: string): Promise<SessionMaterializationJob> {
    const job = await this.status(jobId);
    if (job.state === "publishing" || job.state === "completed" || job.state === "failed") return job;
    if (!job.error?.retryable) throw new Error(`MATERIALIZATION_NOT_RETRYABLE: job ${jobId} cannot be retried`);
    return this.attempt(job);
  }

  public async resync(jobId: string, sessionId: string) {
    const job = await this.status(jobId);
    if (job.state !== "completed") {
      throw new Error("MATERIALIZATION_NOT_COMPLETED: canonical continuation requires a completed handoff");
    }
    const verification = job.verification;
    const target = verification?.canonicalTarget;
    if (!target) {
      throw new Error("MATERIALIZATION_TARGET_UNAVAILABLE: completed handoff has no verified target identity");
    }
    if (!this.publisher?.readCanonicalTarget) {
      throw new Error("MATERIALIZATION_CANONICAL_RESYNC_UNAVAILABLE: no target-bound canonical readback capability is configured");
    }
    const result = await this.publisher.readCanonicalTarget({ target: structuredClone(target) });
    validateTimelineIr(result.canonicalReadback);
    if (!sameTarget(result.canonicalTarget, target)
      || result.canonicalReadback.project.id !== target.projectUid
      || result.canonicalReadback.sequence.id !== target.sequenceUid) {
      throw new Error("MATERIALIZATION_RESYNC_TARGET_MISMATCH: canonical readback does not identify the completed handoff target");
    }
    const readbackDigest = timelineIrDigest(result.canonicalReadback);
    const changeSinceHandoff = verification.canonicalReadbackDigest
      ? readbackDigest === verification.canonicalReadbackDigest ? "unchanged" as const : "changed" as const
      : "unknown" as const;
    const created = await this.sessions.create({
      sessionId,
      base: result.canonicalReadback,
      provider: { id: job.target.provider },
    });
    const continuation = {
      state: "resynced" as const,
      reason: changeSinceHandoff === "changed"
        ? "Canonical state changed after handoff; a fresh session was created from the current target readback."
        : changeSinceHandoff === "unchanged"
          ? "Canonical state matches the handoff readback; a fresh session was created from the current target readback."
          : "A fresh session was created from target-bound canonical readback; comparison with the handoff snapshot was unavailable.",
      sessionId,
      readbackDigest,
      changeSinceHandoff,
      ...(result.delivery ? { delivery: result.delivery } : {}),
    };
    await this.save({ ...job, continuation });
    return {
      jobId,
      state: continuation.state,
      sessionId,
      changeSinceHandoff,
      canonicalTarget: structuredClone(result.canonicalTarget),
      readbackDigest,
      document: created.document,
      ...(result.delivery ? { delivery: result.delivery } : {}),
    };
  }

  private async attempt(job: SessionMaterializationJob): Promise<SessionMaterializationJob> {
    if (!this.publisher || job.state === "publishing") return job;
    const initialFailure = await this.validateStagedJob(job);
    if (initialFailure) return this.fail(job, initialFailure);

    const claim = await this.claim(job);
    if (!claim.owned) return claim.job;
    const claimed = claim.job;
    try {
      const finalFailure = await this.validateStagedJob(claimed);
      if (finalFailure) return this.fail(claimed, finalFailure);
      const result = await this.publisher.publish({
        jobId: claimed.jobId,
        artifactPath: claimed.artifactPath,
        artifactDigest: claimed.artifactDigest,
        target: claimed.target,
        destination: claimed.destination,
        collisionPolicy: "create-only",
        desired: structuredClone(claimed.desired),
        desiredDigest: claimed.desiredDigest,
        baseDigest: claimed.baseDigest,
        baseRevision: structuredClone(claimed.baseRevision),
        coverage: structuredClone(claimed.coverage!),
        provenance: structuredClone(claimed.provenance!),
      });
      if (result.state === "blocked") {
        const blocked: SessionMaterializationJob = {
          ...claimed,
          state: "blocked",
          nextAction: "retry",
          claim: undefined,
          evidence: { ...claimed.evidence, providerRequested: true },
          verification: {
            tier: verificationTierForBlockedCode(result.code),
            status: "blocked",
            artifactDigest: claimed.verification?.artifactDigest ?? claimed.artifactDigest,
            desiredDigest: claimed.verification?.desiredDigest ?? claimed.desiredDigest,
            reason: result.message,
            ...(result.delivery ? { delivery: result.delivery } : { delivery: deliveryEvidenceForBlockedCode(result.code) }),
          },
          error: { code: result.code, message: result.message, retryable: result.retryable },
        };
        await this.save(blocked);
        return blocked;
      }
      if (timelineIrDigest(result.canonicalReadback) !== claimed.desiredDigest) {
        return this.fail(claimed, {
          code: "MATERIALIZATION_READBACK_MISMATCH",
          message: "Canonical provider readback does not match the desired Timeline IR",
          retryable: false,
          providerRequested: true,
          verificationTier: "delivery",
          structuralDiff: createMaterializationStructuralDiff(claimed.desired, result.canonicalReadback),
        });
      }
      const expectedTarget = {
        libraryUid: claimed.target.libraryUid,
        eventUid: claimed.target.eventUid,
        projectUid: claimed.destination.projectUid,
        sequenceUid: claimed.destination.sequenceUid,
      };
      if (!sameTarget(result.canonicalTarget, expectedTarget)) {
        return this.fail(claimed, {
          code: "MATERIALIZATION_TARGET_READBACK_MISMATCH",
          message: "Canonical provider readback does not identify the staged versioned target",
          retryable: false,
          providerRequested: true,
        });
      }
      const completed: SessionMaterializationJob = {
        ...claimed,
        state: "completed",
        nextAction: "none",
        claim: undefined,
        evidence: {
          ...claimed.evidence,
          providerRequested: true,
          canonicalReadback: true,
          headedNative: result.headedNativeVerified,
        },
        error: undefined,
        verification: {
          tier: "canonical-verified",
          status: "verified",
          artifactDigest: claimed.artifactDigest,
          desiredDigest: claimed.desiredDigest,
          canonicalReadbackDigest: timelineIrDigest(result.canonicalReadback),
          canonicalTarget: structuredClone(result.canonicalTarget),
          delivery: result.delivery ?? {
            state: result.headedNativeVerified ? "activated" : "background",
            route: result.headedNativeVerified ? "headed" : "background",
          },
        },
        continuation: {
          state: "canonical-resync-required",
          reason: "Canonical readback verified this handoff once. Re-read the materialized target before later edits to detect subsequent manual Final Cut changes.",
        },
      };
      await this.save(completed);
      return completed;
    } catch (error) {
      return this.fail(claimed, materializationFailure(error, true));
    } finally {
      await this.release(claimed.jobId, claimed.claim!.id);
    }
  }

  private async validateStagedJob(job: SessionMaterializationJob): Promise<MaterializationFailure | undefined> {
    if (!job.desired || !job.desiredDigest || timelineIrDigest(job.desired) !== job.desiredDigest) {
      return {
        code: "MATERIALIZATION_DESIRED_SNAPSHOT_INVALID",
        message: "The staged desired Timeline IR is unavailable or does not match its immutable digest",
        retryable: false,
      };
    }
    if (!job.coverage || !job.provenance) {
      return {
        code: "MATERIALIZATION_JOB_METADATA_UNAVAILABLE",
        message: "This persisted materialization job predates target-bound coverage and provenance; execute a new preview before retrying",
        retryable: false,
      };
    }
    if (job.provenance.timelineDigest !== job.desiredDigest
      || job.provenance.projectId !== job.desired.project.id
      || job.provenance.sequenceId !== job.desired.sequence.id
      || job.provenance.revision?.id !== job.desired.revision.id
      || job.provenance.revision?.sequence !== job.desired.revision.sequence
      || job.provenance.revision?.timestamp !== job.desired.revision.timestamp
      || job.provenance.target?.libraryUid !== job.target.libraryUid
      || job.provenance.target?.eventUid !== job.target.eventUid
      || job.provenance.target?.projectUid !== job.target.projectUid
      || job.provenance.target?.sequenceUid !== job.target.sequenceUid
      || job.provenance.destination?.projectUid !== job.destination.projectUid
      || job.provenance.destination?.sequenceUid !== job.destination.sequenceUid) {
      return {
        code: "MATERIALIZATION_PROVENANCE_INVALID",
        message: "The persisted materialization provenance does not bind to the desired revision and target",
        retryable: false,
      };
    }
    if (!Array.isArray(job.coverage.exact) || !Array.isArray(job.coverage.degraded) || !Array.isArray(job.coverage.unsupported)
      || ![...job.coverage.exact, ...job.coverage.degraded, ...job.coverage.unsupported].every((value) => typeof value === "string" && value.trim())
      || job.coverage.unsupported.length > 0) {
      return {
        code: "MATERIALIZATION_COVERAGE_INVALID",
        message: "The persisted materialization coverage is unsupported or malformed",
        retryable: false,
      };
    }
    if (!job.sessionDigest) {
      return {
        code: "MATERIALIZATION_SESSION_SNAPSHOT_INVALID",
        message: "The materialization job has no immutable session snapshot digest",
        retryable: false,
      };
    }
    if (!job.baseDigest || !job.baseRevision) {
      return {
        code: "MATERIALIZATION_BASE_PROVENANCE_INVALID",
        message: "The materialization job has no immutable canonical base digest and revision",
        retryable: false,
      };
    }
    if (!this.sessions.hasChangeSource()) {
      return {
        code: "MATERIALIZATION_BASE_UNAVAILABLE",
        message: "A canonical session change source is required to verify the staged base before publication",
        retryable: false,
      };
    }
    try {
      const session = await this.sessions.loadForMaterialization(job.sessionId);
      if (session.state() === "possibly_stale" || session.state() === "conflicted"
        || timelineIrDigest(session.base()) !== job.baseDigest
        || !sameRevision(session.base().revision, job.baseRevision)) {
        return {
          code: "MATERIALIZATION_BASE_CHANGED",
          message: "The bound canonical base project, sequence, or revision changed after materialization staging",
          retryable: false,
        };
      }
      if (digestSession(session) !== job.sessionDigest) {
        return {
          code: "MATERIALIZATION_SESSION_CHANGED",
          message: "The editing session changed after materialization staging; reconcile before retrying",
          retryable: false,
        };
      }
      const artifact = await readFile(job.artifactPath, "utf8");
      if (createHash("sha256").update(artifact).digest("hex") !== job.artifactDigest) {
        return {
          code: "MATERIALIZATION_ARTIFACT_CHANGED",
          message: "The staged FCPXML artifact no longer matches its immutable digest",
          retryable: false,
        };
      }
      return undefined;
    } catch (error) {
      return materializationFailure(error, false);
    }
  }

  private async claim(job: SessionMaterializationJob): Promise<{ job: SessionMaterializationJob; owned: boolean }> {
    const claimPath = this.claimPath(job.jobId);
    const claim = { id: randomUUID(), claimedAt: new Date().toISOString() };
    try {
      await writeFile(claimPath, `${JSON.stringify({ jobId: job.jobId, ...claim })}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await this.status(job.jobId);
      if (current.state !== "blocked") return { job: current, owned: false };
      try {
        const existing = JSON.parse(await readFile(claimPath, "utf8")) as { id?: string; claimedAt?: string };
        if (existing.id && existing.claimedAt) {
          return {
            job: { ...current, state: "publishing", nextAction: "status", claim: { id: existing.id, claimedAt: existing.claimedAt } },
            owned: false,
          };
        }
      } catch {
        // The owner may be between creating the claim and persisting state.
      }
      return { job: { ...current, state: "publishing", nextAction: "status" }, owned: false };
    }
    const claimed: SessionMaterializationJob = {
      ...job,
      state: "publishing",
      nextAction: "status",
      claim,
    };
    try {
      await this.save(claimed);
      return { job: claimed, owned: true };
    } catch (error) {
      await unlink(claimPath).catch(() => undefined);
      throw error;
    }
  }

  private async release(jobId: string, claimId: string): Promise<void> {
    const path = this.claimPath(jobId);
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as { id?: string };
      if (current.id === claimId) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async fail(job: SessionMaterializationJob, failure: MaterializationFailure): Promise<SessionMaterializationJob> {
    const failed: SessionMaterializationJob = {
      ...job,
      state: "failed",
      nextAction: "none",
      claim: undefined,
      evidence: {
        ...job.evidence,
        providerRequested: failure.providerRequested ?? job.evidence.providerRequested,
      },
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      verification: {
        tier: failure.verificationTier ?? "artifact",
        status: "failed",
        artifactDigest: job.artifactDigest,
        desiredDigest: job.desiredDigest,
        reason: failure.message,
        ...(failure.structuralDiff ? { structuralDiff: failure.structuralDiff } : {}),
        ...(failure.delivery ? { delivery: failure.delivery } : {}),
      },
    };
    await this.save(failed);
    return failed;
  }

  private async save(job: SessionMaterializationJob): Promise<void> {
    const path = this.jobPath(job.jobId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  }

  private jobPath(jobId: string): string {
    if (!/^materialization-[A-Za-z0-9-]+$/.test(jobId)) throw new Error("MATERIALIZATION_JOB_ID_INVALID: invalid jobId");
    return join(this.directory, "jobs", `${jobId}.json`);
  }

  private claimPath(jobId: string): string {
    return `${this.jobPath(jobId)}.claim`;
  }

  private assertProvider(sessionProvider: string | undefined, targetProvider: string): void {
    if (sessionProvider && sessionProvider !== targetProvider) {
      throw new Error(`SESSION_PROVIDER_MISMATCH: expected ${sessionProvider}, received ${targetProvider}`);
    }
  }
}

interface MaterializationFailure {
  code: string;
  message: string;
  retryable: boolean;
  providerRequested?: boolean;
  verificationTier?: MaterializationVerificationTier;
  structuralDiff?: MaterializationStructuralDiff;
  delivery?: MaterializationDeliveryEvidence;
}

function digestSession(session: { serialize(): string }): string {
  return createHash("sha256").update(session.serialize()).digest("hex");
}

function compileTimelineIrToFcxmlVersioned(
  desired: TimelineIr,
  target: TimelineIrToFcpxmlTarget,
): TimelineIrToFcpxmlResult {
  if (target.materialization === "reuse-existing") {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_REUSE_FORBIDDEN: materialization jobs are create-only");
  }
  return compileTimelineIrToFcpxml(desired, { target: { ...target, materialization: "versioned" } });
}

function normalizePersistedJob(job: SessionMaterializationJob): SessionMaterializationJob {
  if (job.schemaVersion === 2) return job;
  if (job.coverage && job.provenance) return { ...job, schemaVersion: 2 };
  return {
    ...job,
    schemaVersion: 2,
    state: "failed",
    nextAction: "none",
    claim: undefined,
    error: {
      code: "MATERIALIZATION_JOB_METADATA_UNAVAILABLE",
      message: "This persisted materialization job predates target-bound coverage and provenance; execute a new preview before retrying",
      retryable: false,
    },
  };
}

function materializationFailure(error: unknown, providerRequested: boolean): MaterializationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/^([A-Z][A-Z0-9_]*):/)?.[1] ?? "MATERIALIZATION_PUBLISH_FAILED";
  return { code, message, retryable: false, providerRequested };
}

function verificationTierForBlockedCode(code: string): MaterializationVerificationTier {
  return /INTERACTION_REQUIRED|CONSOLE_LOCKED|PROMPT/i.test(code) ? "interaction-required" : "artifact";
}

function deliveryEvidenceForBlockedCode(code: string): MaterializationDeliveryEvidence {
  if (/INTERACTION_REQUIRED/i.test(code)) return { state: "interaction-required", route: "headed" };
  if (/PROMPT/i.test(code)) return { state: "prompted", route: "headed" };
  return { state: "failed", route: "unknown" };
}

function createMaterializationStructuralDiff(desired: TimelineIr, actual: TimelineIr): MaterializationStructuralDiff {
  const changes: MaterializationStructuralDiff["changes"] = [];
  collectStructuralChanges(desired, actual, "", changes);
  return {
    target: { projectId: desired.project.id, sequenceId: desired.sequence.id },
    desiredDigest: timelineIrDigest(desired),
    actualDigest: timelineIrDigest(actual),
    changes,
  };
}

function collectStructuralChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: MaterializationStructuralDiff["changes"],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectStructuralChanges(before[index], after[index], `${path}[${index}]`, changes);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      collectStructuralChanges(before[key], after[key], path ? `${path}.${key}` : key, changes);
    }
    return;
  }
  changes.push({ path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameRevision(left: TimelineIr["revision"], right: TimelineIr["revision"] | undefined): boolean {
  return right !== undefined
    && left.id === right.id
    && left.sequence === right.sequence
    && left.timestamp === right.timestamp;
}

function sameTarget(
  actual: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string } | undefined,
  expected: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string },
): boolean {
  return actual?.libraryUid === expected.libraryUid
    && actual.eventUid === expected.eventUid
    && actual.projectUid === expected.projectUid
    && actual.sequenceUid === expected.sequenceUid;
}
