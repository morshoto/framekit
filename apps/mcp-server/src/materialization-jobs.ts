import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  desired: TimelineIr;
  desiredDigest: string;
}

export interface SessionMaterializationPublisher {
  publish(request: SessionMaterializationPublishRequest): Promise<
    | { state: "completed"; canonicalReadback: TimelineIr; headedNativeVerified: boolean }
    | { state: "blocked"; code: string; message: string; retryable: boolean }
  >;
}

export interface SessionMaterializationJob {
  schemaVersion: 1;
  jobId: string;
  sessionId: string;
  state: "blocked" | "completed" | "failed";
  nextAction: "retry" | "none";
  artifactPath: string;
  artifactDigest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  desired: TimelineIr;
  desiredDigest: string;
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
    const artifact = compileTimelineIrToFcpxml(session.desired(), { target });
    return {
      sessionId,
      mutating: false,
      sessionState: session.state(),
      target: artifact.target,
      destination: artifact.destination,
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
    const artifact = compileTimelineIrToFcpxml(desired, { target });
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
    if (!this.publisher) return job;

    const result = await this.publisher.publish({
      jobId,
      artifactPath,
      artifactDigest: artifact.digest,
      target: artifact.target,
      destination: artifact.destination,
      desired,
      desiredDigest: job.desiredDigest,
    });
    if (result.state === "blocked") {
      job = {
        ...job,
        evidence: { ...job.evidence, providerRequested: true },
        error: { code: result.code, message: result.message, retryable: result.retryable },
      };
      await this.save(job);
      return job;
    }
    if (timelineIrDigest(result.canonicalReadback) !== timelineIrDigest(desired)) {
      job = {
        ...job,
        state: "failed",
        nextAction: "none",
        evidence: { ...job.evidence, providerRequested: true },
        error: {
          code: "MATERIALIZATION_READBACK_MISMATCH",
          message: "Canonical provider readback does not match the desired Timeline IR",
          retryable: false,
        },
      };
      await this.save(job);
      return job;
    }
    job = {
      ...job,
      state: "completed",
      nextAction: "none",
      evidence: {
        ...job.evidence,
        providerRequested: true,
        canonicalReadback: true,
        headedNative: result.headedNativeVerified,
      },
      error: undefined,
    };
    await this.save(job);
    return job;
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
    if (job.state === "completed" || job.state === "failed") return job;
    if (!job.error?.retryable) throw new Error(`MATERIALIZATION_NOT_RETRYABLE: job ${jobId} cannot be retried`);
    if (!this.publisher) return job;
    if (!job.desired || timelineIrDigest(job.desired) !== job.desiredDigest) {
      const failed: SessionMaterializationJob = {
        ...job,
        state: "failed",
        nextAction: "none",
        error: {
          code: "MATERIALIZATION_DESIRED_SNAPSHOT_INVALID",
          message: "The staged desired Timeline IR is unavailable or does not match its immutable digest",
          retryable: false,
        },
      };
      await this.save(failed);
      return failed;
    }

    const artifact = await readFile(job.artifactPath, "utf8");
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== job.artifactDigest) {
      const failed: SessionMaterializationJob = {
        ...job,
        state: "failed",
        nextAction: "none",
        error: {
          code: "MATERIALIZATION_ARTIFACT_CHANGED",
          message: "The staged FCPXML artifact no longer matches its immutable digest",
          retryable: false,
        },
      };
      await this.save(failed);
      return failed;
    }

    const result = await this.publisher.publish({
      jobId: job.jobId,
      artifactPath: job.artifactPath,
      artifactDigest: job.artifactDigest,
      target: job.target,
      destination: job.destination,
      desired: structuredClone(job.desired),
      desiredDigest: job.desiredDigest,
    });
    if (result.state === "blocked") {
      const blocked: SessionMaterializationJob = {
        ...job,
        evidence: { ...job.evidence, providerRequested: true },
        error: { code: result.code, message: result.message, retryable: result.retryable },
      };
      await this.save(blocked);
      return blocked;
    }
    if (timelineIrDigest(result.canonicalReadback) !== job.desiredDigest) {
      const failed: SessionMaterializationJob = {
        ...job,
        state: "failed",
        nextAction: "none",
        evidence: { ...job.evidence, providerRequested: true },
        error: {
          code: "MATERIALIZATION_READBACK_MISMATCH",
          message: "Canonical provider readback does not match the desired Timeline IR",
          retryable: false,
        },
      };
      await this.save(failed);
      return failed;
    }
    const completed: SessionMaterializationJob = {
      ...job,
      state: "completed",
      nextAction: "none",
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

  private assertProvider(sessionProvider: string | undefined, targetProvider: string): void {
    if (sessionProvider && sessionProvider !== targetProvider) {
      throw new Error(`SESSION_PROVIDER_MISMATCH: expected ${sessionProvider}, received ${targetProvider}`);
    }
  }
}
