import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { timelineIrDigest, type TimelineIr } from "@framekit/runtime";
import {
  compileTimelineIrToFcpxml,
  type TimelineIrToFcpxmlResult,
  type TimelineIrToFcpxmlTarget,
} from "@framekit/final-cut";
import { EditingSessionRepository } from "./headless-sessions.js";

export interface SessionMaterializationPublishRequest {
  jobId: string;
  artifactPath: string;
  artifactDigest: string;
  claim: { id: string; claimedAt: string; leaseExpiresAt: string };
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  collisionPolicy: "create-only";
  desired: TimelineIr;
  desiredDigest: string;
}

export interface SessionMaterializationPublisher {
  publish(request: SessionMaterializationPublishRequest): Promise<
    | {
        state: "completed";
        canonicalReadback: TimelineIr;
        canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
        headedNativeVerified: boolean;
      }
    | { state: "blocked"; code: string; message: string; retryable: boolean }
  >;
  reconcile?(request: SessionMaterializationPublishRequest): Promise<
    | {
        state: "completed";
        canonicalReadback: TimelineIr;
        canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
        headedNativeVerified: boolean;
      }
    | { state: "not-found" }
    | { state: "unknown"; code: string; message: string; retryable: false }
  >;
}

export interface SessionMaterializationJob {
  schemaVersion: 1;
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
  sessionDigest: string;
  claim?: { id: string; claimedAt: string; leaseExpiresAt: string };
  evidence: {
    artifact: { verified: true; format: "fcpxml"; digest: string };
    providerRequested: boolean;
    canonicalReadback: boolean;
    headedNative: boolean;
  };
  error?: { code: string; message: string; retryable: boolean; recovery?: "required" };
}

const MATERIALIZATION_CLAIM_LEASE_MS = 120_000;

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
      schemaVersion: 1,
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
      sessionDigest: digestSession(session),
      evidence: {
        artifact: { verified: true, format: "fcpxml", digest: artifact.digest },
        providerRequested: false,
        canonicalReadback: false,
        headedNative: false,
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
      if (job.schemaVersion !== 1 || job.jobId !== jobId) throw new Error("MATERIALIZATION_JOB_INVALID: persisted job is invalid");
      return structuredClone(job);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`MATERIALIZATION_JOB_NOT_FOUND: unknown materialization job ${jobId}`);
      }
      throw error;
    }
  }

  public async retry(jobId: string): Promise<SessionMaterializationJob> {
    const job = await this.status(jobId);
    if (job.error?.recovery === "required") return this.recover(job);
    if (job.state === "publishing") {
      if (job.claim && claimLeaseActive(job.claim)) return job;
      return this.recover(job);
    }
    if (job.state === "completed" || job.state === "failed") return job;
    if (!job.error?.retryable) throw new Error(`MATERIALIZATION_NOT_RETRYABLE: job ${jobId} cannot be retried`);
    return this.attempt(job);
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
      await this.assertClaimOwnership(claimed.jobId, claimed.claim!.id);
      const result = await this.publisher.publish({
        jobId: claimed.jobId,
        artifactPath: claimed.artifactPath,
        artifactDigest: claimed.artifactDigest,
        claim: structuredClone(claimed.claim!),
        target: claimed.target,
        destination: claimed.destination,
        collisionPolicy: "create-only",
        desired: structuredClone(claimed.desired),
        desiredDigest: claimed.desiredDigest,
      });
      if (result.state === "blocked") {
        const blocked: SessionMaterializationJob = {
          ...claimed,
          state: "blocked",
          nextAction: result.retryable ? "retry" : "none",
          claim: undefined,
          evidence: { ...claimed.evidence, providerRequested: true },
          error: { code: result.code, message: result.message, retryable: result.retryable },
        };
        await this.save(blocked);
        return blocked;
      }
      const completionFailure = completionValidation(claimed, result);
      if (completionFailure) return this.fail(claimed, completionFailure);
      return this.complete(claimed, result);
    } catch (error) {
      return this.fail(claimed, materializationFailure(error, true));
    } finally {
      await this.release(claimed.jobId, claimed.claim!.id);
    }
  }

  private async recover(job: SessionMaterializationJob): Promise<SessionMaterializationJob> {
    const claim = job.claim;
    if (!claim) {
      return this.persistRecovery(job, {
        code: "MATERIALIZATION_RECOVERY_CLAIM_UNAVAILABLE",
        message: "The uncertain publication has no durable claim identity to reconcile",
        retryable: false,
        providerRequested: true,
        recovery: "required",
      });
    }
    if (!job.desired || !job.desiredDigest || timelineIrDigest(job.desired) !== job.desiredDigest) {
      return this.fail(job, {
        code: "MATERIALIZATION_DESIRED_SNAPSHOT_INVALID",
        message: "The staged desired Timeline IR is unavailable or does not match its immutable digest",
        retryable: false,
      });
    }
    if (!this.publisher?.reconcile) {
      return this.persistRecovery(job, {
        code: "MATERIALIZATION_RECOVERY_UNAVAILABLE",
        message: "The publisher cannot reconcile whether the uncertain publication completed",
        retryable: false,
        providerRequested: true,
        recovery: "required",
      });
    }

    let result;
    try {
      result = await this.publisher.reconcile(this.publishRequest(job, claim));
    } catch (error) {
      return this.persistRecovery(job, materializationFailure(error, true));
    }
    if (result.state === "unknown") {
      return this.persistRecovery(job, {
        code: result.code,
        message: result.message,
        retryable: false,
        providerRequested: true,
        recovery: "required",
      });
    }
    if (result.state === "completed") {
      const completionFailure = completionValidation(job, result, true);
      if (completionFailure) return this.persistRecovery(job, completionFailure);
      const completed = await this.complete(job, result);
      await this.release(job.jobId, claim.id);
      return completed;
    }

    await this.release(job.jobId, claim.id);
    const retryable: SessionMaterializationJob = {
      ...job,
      state: "blocked",
      nextAction: "retry",
      claim: undefined,
      error: {
        code: "MATERIALIZATION_RECOVERY_CONFIRMED_ABSENT",
        message: "The provider confirmed that no matching publication completed; retry is safe",
        retryable: true,
      },
    };
    await this.save(retryable);
    return this.attempt(retryable);
  }

  private publishRequest(
    job: SessionMaterializationJob,
    claim: { id: string; claimedAt: string; leaseExpiresAt: string },
  ): SessionMaterializationPublishRequest {
    return {
      jobId: job.jobId,
      artifactPath: job.artifactPath,
      artifactDigest: job.artifactDigest,
      claim: structuredClone(claim),
      target: job.target,
      destination: job.destination,
      collisionPolicy: "create-only",
      desired: structuredClone(job.desired),
      desiredDigest: job.desiredDigest,
    };
  }

  private async complete(
    job: SessionMaterializationJob,
    result: {
      state: "completed";
      canonicalReadback: TimelineIr;
      canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
      headedNativeVerified: boolean;
    },
  ): Promise<SessionMaterializationJob> {
    const completed: SessionMaterializationJob = {
      ...job,
      state: "completed",
      nextAction: "none",
      claim: undefined,
      evidence: {
        ...job.evidence,
        providerRequested: true,
        canonicalReadback: true,
        headedNative: result.headedNativeVerified,
      },
      error: undefined,
    };
    await this.save(completed);
    return completed;
  }

  private async validateStagedJob(job: SessionMaterializationJob): Promise<MaterializationFailure | undefined> {
    if (!job.desired || !job.desiredDigest || timelineIrDigest(job.desired) !== job.desiredDigest) {
      return {
        code: "MATERIALIZATION_DESIRED_SNAPSHOT_INVALID",
        message: "The staged desired Timeline IR is unavailable or does not match its immutable digest",
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
    try {
      const session = await this.sessions.loadForMaterialization(job.sessionId);
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
    const claimedAt = Date.now();
    const claim = {
      id: randomUUID(),
      claimedAt: new Date(claimedAt).toISOString(),
      leaseExpiresAt: new Date(claimedAt + MATERIALIZATION_CLAIM_LEASE_MS).toISOString(),
    };
    try {
      await writeFile(claimPath, `${JSON.stringify({ jobId: job.jobId, ...claim })}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await this.status(job.jobId);
      if (current.state !== "blocked") return { job: current, owned: false };
      try {
        const existing = JSON.parse(await readFile(claimPath, "utf8")) as { id?: string; claimedAt?: string; leaseExpiresAt?: string };
        if (existing.id && existing.claimedAt && existing.leaseExpiresAt) {
          return {
            job: { ...current, state: "publishing", nextAction: "status", claim: { id: existing.id, claimedAt: existing.claimedAt, leaseExpiresAt: existing.leaseExpiresAt } },
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

  private async assertClaimOwnership(jobId: string, claimId: string): Promise<void> {
    try {
      const current = JSON.parse(await readFile(this.claimPath(jobId), "utf8")) as { id?: string };
      if (current.id !== claimId) throw new Error("MATERIALIZATION_CLAIM_FENCED: another publisher owns this materialization claim");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("MATERIALIZATION_CLAIM_FENCED: materialization claim is no longer active");
      }
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

  private async persistRecovery(job: SessionMaterializationJob, failure: MaterializationFailure): Promise<SessionMaterializationJob> {
    const recovery: SessionMaterializationJob = {
      ...job,
      state: "blocked",
      nextAction: "status",
      evidence: {
        ...job.evidence,
        providerRequested: failure.providerRequested ?? job.evidence.providerRequested,
      },
      error: {
        code: failure.code,
        message: failure.message,
        retryable: false,
        recovery: "required",
      },
    };
    await this.save(recovery);
    return recovery;
  }

  private async fail(job: SessionMaterializationJob, failure: MaterializationFailure): Promise<SessionMaterializationJob> {
    const failed: SessionMaterializationJob = {
      ...job,
      state: failure.recovery ? "blocked" : "failed",
      nextAction: failure.recovery ? "status" : "none",
      claim: failure.recovery ? job.claim : undefined,
      evidence: {
        ...job.evidence,
        providerRequested: failure.providerRequested ?? job.evidence.providerRequested,
      },
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        ...(failure.recovery ? { recovery: failure.recovery } : {}),
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
  recovery?: "required";
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

function materializationFailure(error: unknown, providerRequested: boolean): MaterializationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/^([A-Z][A-Z0-9_]*):/)?.[1] ?? "MATERIALIZATION_PUBLISH_FAILED";
  return { code, message, retryable: false, providerRequested, ...(providerRequested ? { recovery: "required" as const } : {}) };
}

function completionValidation(
  job: SessionMaterializationJob,
  result: {
    state: "completed";
    canonicalReadback: TimelineIr;
    canonicalTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
    headedNativeVerified: boolean;
  },
  recovery = false,
): MaterializationFailure | undefined {
  if (timelineIrDigest(result.canonicalReadback) !== job.desiredDigest) {
    return {
      code: recovery ? "MATERIALIZATION_RECOVERY_READBACK_MISMATCH" : "MATERIALIZATION_READBACK_MISMATCH",
      message: recovery
        ? "Reconciliation returned a canonical readback that does not match the uncertain publication"
        : "Canonical provider readback does not match the desired Timeline IR",
      retryable: false,
      providerRequested: true,
      ...(recovery ? { recovery: "required" as const } : {}),
    };
  }
  const expectedTarget = {
    libraryUid: job.target.libraryUid,
    eventUid: job.target.eventUid,
    projectUid: job.destination.projectUid,
    sequenceUid: job.destination.sequenceUid,
  };
  if (!sameTarget(result.canonicalTarget, expectedTarget)) {
    return {
      code: recovery ? "MATERIALIZATION_RECOVERY_TARGET_MISMATCH" : "MATERIALIZATION_TARGET_READBACK_MISMATCH",
      message: recovery
        ? "Reconciliation returned a target that does not match the uncertain publication"
        : "Canonical provider readback does not identify the staged versioned target",
      retryable: false,
      providerRequested: true,
      ...(recovery ? { recovery: "required" as const } : {}),
    };
  }
  return undefined;
}

function claimLeaseActive(claim: { leaseExpiresAt: string }): boolean {
  const expiry = Date.parse(claim.leaseExpiresAt);
  return Number.isFinite(expiry) && expiry > Date.now();
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
