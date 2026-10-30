import { execFile as execFileCallback } from "node:child_process";
import { chmodSync, constants, createReadStream, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, lstat, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EditorLiveState, ProjectSnapshot } from "@framekit/runtime";
import { FcpxmlDocumentAdapter } from "./fcpxml.js";
import { verifyFinalCutPublishReadback, type FinalCutPublishReadbackEvidence } from "./publish-readback.js";
import type { FinalCutFcpxmlDelivery } from "./live.js";

const execFile = promisify(execFileCallback);

export interface FinalCutPublishSourceMediaDigest {
  source: string;
  sha256: string;
}

export interface FinalCutProjectPublishDelivery {
  status: "dispatched";
  route: "background-document-open" | "headed-apple-event";
  requestedActivates: boolean;
  activation: FinalCutFcpxmlDelivery["activation"];
  ui: FinalCutFcpxmlDelivery["ui"];
  target: FinalCutFcpxmlDelivery["target"];
}

export interface FinalCutProjectPublishResult {
  sourceTransactionId: string;
  sourcePath: string;
  sourceTarget: {
    kind: "artifact";
    artifactPath: string;
  };
  importedPath: string;
  projectName: string;
  createdTarget: {
    kind: "editor.project";
    projectId: string;
    sequenceId: string;
    libraryId?: string;
    eventId?: string;
    libraryPath?: string;
    projectName: string;
    sequenceName?: string;
  };
  activeProject: {
    before?: { id: string; name: string };
    after?: { id: string; name: string };
    changed?: boolean;
  };
  verified: boolean;
  importedDigest: string;
  semanticReadback: FinalCutPublishReadbackEvidence;
  sourceMediaIntegrity: {
    unchanged: true;
    digests: FinalCutPublishSourceMediaDigest[];
  };
  targetLibraryPath?: string;
  liveProject?: string;
  liveSequence?: string;
  delivery?: FinalCutProjectPublishDelivery;
}

export interface FinalCutProjectPublishRequest {
  sourceTransactionId: string;
  artifactPath: string;
  artifactDigest: string;
  targetLibraryPath?: string;
  confirm: boolean;
  confirmVerification?: boolean;
}

export interface FinalCutProjectPublishPreparationRequest {
  sourceTransactionId: string;
  artifactPath: string;
  artifactDigest: string;
  targetLibraryPath?: string;
}

export interface FinalCutProjectPublishTargetBinding {
  projectId: string;
  sequenceId: string;
  libraryId?: string;
  eventId?: string;
  libraryPath?: string;
}

export interface FinalCutProjectPublishReadiness {
  available: boolean;
  targetBindingAvailable: boolean;
  reasons: Array<{ code: string; message: string }>;
}

export interface FinalCutHeadlessPublishSourceProof {
  targetLibraryUid: string;
  sourceMediaDigests: FinalCutPublishSourceMediaDigest[];
}
export type FinalCutProjectPublishJobState =
  | "awaiting-confirmation"
  | "awaiting-final-cut"
  | "verification-pending"
  | "verified"
  | "failed";

export type FinalCutProjectPublishJobAction = "confirm" | "confirm-verification" | "retry" | "status" | "none";

export interface FinalCutProjectPublishJob {
  jobId: string;
  state: FinalCutProjectPublishJobState;
  nextAction: FinalCutProjectPublishJobAction;
  retryable: boolean;
  executionMode: "headed-only" | "background-capable";
  sourceTransactionId: string;
  sourcePath: string;
  sourceTarget: {
    kind: "artifact";
    artifactPath: string;
  };
  artifactDigest: string;
  targetLibraryPath?: string;
  projectName: string;
  sequenceName: string;
  confirmationRequired: boolean;
  handoff: {
    mode: "headed-only" | "background-document-open";
    route: FinalCutProjectPublishRoute;
    backgroundSupported: boolean;
    reason: string;
  };
  /** Dispatch acknowledgement alone does not prove a native project exists. */
  delivery?: FinalCutProjectPublishDelivery;
  /** Matching live target observation; this does not prove semantic readback. */
  observedTarget?: FinalCutProjectPublishTargetBinding;
  createdTarget?: FinalCutProjectPublishResult["createdTarget"];
  result?: FinalCutProjectPublishResult;
  error?: {
    code: string;
    message: string;
  };
}

export type FinalCutProjectPublishRoute = "background-document-open" | "headed-apple-event";

export function parseFinalCutProjectPublishRoute(
  value: string | undefined,
  backgroundDeliveryAvailable: boolean,
): FinalCutProjectPublishRoute {
  if (value === undefined || value === "") {
    return backgroundDeliveryAvailable ? "background-document-open" : "headed-apple-event";
  }
  if (value === "background-document-open" || value === "headed-apple-event") return value;
  throw new Error(`FRAMEKIT_FINAL_CUT_PUBLISH_ROUTE_INVALID: unsupported route ${value}`);
}

export interface FinalCutProjectPublisherOptions {
  enabled?: boolean;
  sourcePath: string;
  executor?: (script: string) => Promise<string>;
  liveState?: () => Promise<EditorLiveState>;
  /** Reads the exact created target from the requested native library after import. */
  targetBinding?: (
    targetLibraryPath: string | undefined,
    identity: { projectName: string; sequenceName: string },
  ) => Promise<FinalCutProjectPublishTargetBinding>;
  /** Exports the active target through Final Cut for semantic verification. */
  readCanonicalSnapshot?: (
    targetBinding: FinalCutProjectPublishTargetBinding,
    identity: { projectName: string; sequenceName: string },
  ) => Promise<ProjectSnapshot>;
  /** Validates an approved headless rough-cut execution for external artifact paths. */
  headlessSourceVerifier?: (request: FinalCutProjectPublishPreparationRequest) => Promise<FinalCutHeadlessPublishSourceProof>;
  /** Opens the staged FCPXML through the native Workflow Extension bridge. */
  documentDelivery?: {
    deliverFcpxml(request: { artifactPath: string; targetLibraryLocation?: string; activates: boolean }): Promise<FinalCutFcpxmlDelivery>;
  };
  /** Selects the native delivery route before preview and user confirmation. */
  publishRoute?: FinalCutProjectPublishRoute;
  /** Stores publish jobs so verification can resume after an MCP restart. */
  publishJobsDirectory?: string;
  verificationTimeoutMs?: number;
  pollIntervalMs?: number;
  /** @deprecated Use pollIntervalMs. */
  waitMs?: number;
}

interface PublishJobRuntime {
  beforeLive: EditorLiveState;
  identity: { projectName: string; sequenceName: string };
  targetLibraryPath?: string;
  /** Logical UID from the source FCPXML; Final Cut assigns the native library ID on import. */
  targetLibraryUid?: string;
  importedPath?: string;
  importedDigest?: string;
  delivery?: FinalCutProjectPublishDelivery;
  reservationPath?: string;
  reservationId?: string;
  importAttempted?: boolean;
  expectedSnapshot?: ProjectSnapshot;
  sourceMediaDigests?: FinalCutPublishSourceMediaDigest[];
  approvedSourceMediaDigests?: FinalCutPublishSourceMediaDigest[];
}

interface PersistedPublishJob {
  version: 1;
  job: FinalCutProjectPublishJob;
  runtime?: PublishJobRuntime;
}

/** Imports a validated FCPXML artifact as a new Final Cut project. */
export class FinalCutProjectPublisher {
  private readonly enabled: boolean;
  private readonly sourcePath: string;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly targetBinding?: FinalCutProjectPublisherOptions["targetBinding"];
  private readonly readCanonicalSnapshot?: FinalCutProjectPublisherOptions["readCanonicalSnapshot"];
  private readonly headlessSourceVerifier?: FinalCutProjectPublisherOptions["headlessSourceVerifier"];
  private readonly documentDelivery?: FinalCutProjectPublisherOptions["documentDelivery"];
  private readonly publishRoute: FinalCutProjectPublishRoute;
  private readonly publishJobsDirectory?: string;
  private readonly verificationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly publishJobs = new Map<string, FinalCutProjectPublishJob>();
  private readonly publishJobRuntime = new Map<string, PublishJobRuntime>();

  public constructor(options: FinalCutProjectPublisherOptions) {
    this.enabled = options.enabled ?? false;
    this.sourcePath = options.sourcePath;
    this.executor = options.executor ?? runAppleScript;
    this.liveState = options.liveState;
    this.targetBinding = options.targetBinding;
    this.readCanonicalSnapshot = options.readCanonicalSnapshot;
    this.headlessSourceVerifier = options.headlessSourceVerifier;
    this.documentDelivery = options.documentDelivery;
    this.publishRoute = options.publishRoute ?? (this.documentDelivery ? "background-document-open" : "headed-apple-event");
    this.publishJobsDirectory = options.publishJobsDirectory;
    this.verificationTimeoutMs = Math.max(0, options.verificationTimeoutMs ?? 15_000);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? options.waitMs ?? 100);
    this.loadPersistedPublishJobs();
  }

  public isAvailable(): boolean {
    return this.inspectReadiness().available;
  }

  /** Describe configured handoff providers without querying or changing Final Cut. */
  public inspectReadiness(): FinalCutProjectPublishReadiness {
    const reasons: FinalCutProjectPublishReadiness["reasons"] = [];
    if (!this.enabled) {
      reasons.push({
        code: "FINAL_CUT_PUBLISH_DISABLED",
        message: "Final Cut project publishing is disabled",
      });
    }
    if (!this.liveState) {
      reasons.push({
        code: "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
        message: "Live Final Cut project and sequence verification is unavailable",
      });
    }
    if (!this.targetBinding) {
      reasons.push({
        code: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE",
        message: "No native provider can bind the imported artifact to a created target",
      });
    }
    if (!this.readCanonicalSnapshot) {
      reasons.push({
        code: "FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE",
        message: "Headed canonical timeline readback is unavailable",
      });
    }
    return {
      available: reasons.length === 0,
      targetBindingAvailable: Boolean(this.targetBinding),
      reasons,
    };
  }

  public executionMode(): "background-capable" | "headed-only" {
    // Dispatch may be background-capable, but native semantic readback uses
    // Final Cut's headed File > Export XML command.
    return "headed-only";
  }

  public async preparePublish(
    request: FinalCutProjectPublishPreparationRequest,
  ): Promise<FinalCutProjectPublishJob> {
    const validated = await this.readValidatedSource(request);
    const targetLibraryPath = await validateTargetLibraryPath(
      request.targetLibraryPath,
      Boolean(this.documentDelivery)
        || request.sourceTransactionId.startsWith("headless-rough-cut:"),
    );
    const job: FinalCutProjectPublishJob = {
      jobId: `publish-job-${randomUUID()}`,
      state: "awaiting-confirmation",
      nextAction: "confirm",
      retryable: false,
      executionMode: "headed-only",
      sourceTransactionId: request.sourceTransactionId,
      sourcePath: request.artifactPath,
      sourceTarget: { kind: "artifact", artifactPath: request.artifactPath },
      artifactDigest: request.artifactDigest,
      ...(targetLibraryPath ? { targetLibraryPath } : {}),
      projectName: validated.identity.projectName,
      sequenceName: validated.identity.sequenceName,
      confirmationRequired: true,
      handoff: {
        mode: this.publishRoute === "background-document-open" ? "background-document-open" : "headed-only",
        route: this.publishRoute,
        backgroundSupported: this.publishRoute === "background-document-open",
        reason: publishHandoffReason(this.publishRoute),
      },
    };
    this.persistPublishJob(job);
    return clonePublishJob(job);
  }

  public getPublishJob(jobId: string): FinalCutProjectPublishJob {
    const job = this.publishJobs.get(jobId);
    if (!job) throw new Error(`PUBLISH_JOB_NOT_FOUND: unknown publish job ${jobId}`);
    return clonePublishJob(job);
  }

  public async executePublishJob(
    jobId: string,
    confirm: boolean,
    confirmVerification = false,
  ): Promise<FinalCutProjectPublishJob> {
    const storedJob = this.publishJobs.get(jobId);
    if (!storedJob) throw new Error(`PUBLISH_JOB_NOT_FOUND: unknown publish job ${jobId}`);
    const job = clonePublishJob(storedJob);
    if (job.state === "verified") return clonePublishJob(job);
    if (job.state === "failed" && !job.retryable) return clonePublishJob(job);
    if (!confirm) throw new Error("PUBLISH_CONFIRMATION_REQUIRED: set confirm=true to create a new Final Cut project");

    // Once a dispatch may have occurred, unavailable providers must never
    // transition the job back to a state that can dispatch again.
    if (job.state === "verification-pending") {
      if (!confirmVerification) {
        job.nextAction = "confirm-verification";
        job.retryable = false;
        this.persistPublishJob(job);
        return clonePublishJob(job);
      }
      if (!this.enabled || !this.liveState || !this.targetBinding || !this.readCanonicalSnapshot) {
        job.nextAction = "retry";
        job.retryable = true;
        job.error = {
          code: "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
          message: "Verification is unavailable; retain this job and resume verification without dispatching again",
        };
        this.persistPublishJob(job);
        return clonePublishJob(job);
      }
      return this.resumePublishVerification(job);
    }

    if (!this.enabled) {
      job.state = "awaiting-final-cut";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = {
        code: "CAPABILITY_UNAVAILABLE",
        message: "Final Cut project publishing is unavailable; bring Final Cut Pro to the front and retry this job",
      };
      this.persistPublishJob(job);
      return clonePublishJob(job);
    }

    if (!this.liveState) return this.markAwaitingFinalCut(
      job,
      "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
      "Final Cut project state verification is unavailable; retry this job when the live provider is ready",
    );

    if (!this.readCanonicalSnapshot) {
      return this.markFailed(job, new Error("FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE: headed canonical timeline readback is not configured; no import was attempted"));
    }

    let validated: Awaited<ReturnType<FinalCutProjectPublisher["readValidatedSource"]>>;
    try {
      validated = await this.readValidatedSource({
        sourceTransactionId: job.sourceTransactionId,
        artifactPath: job.sourcePath,
        artifactDigest: job.artifactDigest,
        ...(job.targetLibraryPath ? { targetLibraryPath: job.targetLibraryPath } : {}),
      });
      await validateTargetLibraryPath(
        job.targetLibraryPath,
        Boolean(this.documentDelivery) || job.sourceTransactionId.startsWith("headless-rough-cut:"),
      );
    } catch (error) {
      return this.markFailed(job, error);
    }

    if (!this.targetBinding) {
      return this.markFailed(job, new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted"));
    }

    let beforeLive: EditorLiveState;
    try {
      beforeLive = await readLiveState(this.liveState, "before import");
    } catch (error) {
      const normalized = publishError(error);
      return this.markAwaitingFinalCut(job, normalized.code, normalized.message);
    }

    const runtime: PublishJobRuntime = {
      beforeLive,
      identity: validated.identity,
      ...(job.targetLibraryPath ? { targetLibraryPath: job.targetLibraryPath } : {}),
      ...(validated.sourceProof ? { targetLibraryUid: validated.sourceProof.targetLibraryUid } : {}),
      ...(validated.sourceProof ? { approvedSourceMediaDigests: structuredClone(validated.sourceProof.sourceMediaDigests) } : {}),
    };
    const previousRuntime = this.publishJobRuntime.get(job.jobId);
    this.publishJobRuntime.set(job.jobId, runtime);
    job.state = "verification-pending";
    job.nextAction = "status";
    job.retryable = false;
    try {
      this.persistPublishJob(job);
    } catch (error) {
      if (previousRuntime) this.publishJobRuntime.set(job.jobId, previousRuntime);
      else this.publishJobRuntime.delete(job.jobId);
      throw error;
    }
    try {
      const result = await this.importAndVerify(
        {
          sourceTransactionId: job.sourceTransactionId,
          artifactPath: job.sourcePath,
          artifactDigest: job.artifactDigest,
          ...(job.targetLibraryPath ? { targetLibraryPath: job.targetLibraryPath } : {}),
          confirm: true,
        },
        validated.source,
        validated.identity,
        beforeLive,
        runtime,
        job,
      );
      if (!result) {
        job.state = "verification-pending";
        job.nextAction = "confirm-verification";
        job.retryable = false;
        delete job.error;
        this.persistPublishJob(job);
        return clonePublishJob(job);
      }
      return this.markVerified(job, result);
    } catch (error) {
      const normalized = publishError(error);
      if (normalized.code === "PUBLISH_TARGET_LIBRARY_RESERVED") return this.markFailed(job, error);
      if (!runtime.importAttempted) {
        await releaseTargetLibraryReservation(runtime);
        return this.markAwaitingFinalCut(job, normalized.code, normalized.message);
      }
      job.state = "verification-pending";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = normalized;
      this.persistPublishJob(job);
      return clonePublishJob(job);
    }
  }

  public async publishNewProject(request: FinalCutProjectPublishRequest): Promise<FinalCutProjectPublishResult> {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing is disabled; configure FRAMEKIT_EDITOR=final-cut-live and FRAMEKIT_FCPXML_PATH, and ensure Final Cut is reachable through FRAMEKIT_FINAL_CUT_SOCKET");
    if (!request.confirm) throw new Error("PUBLISH_CONFIRMATION_REQUIRED: set confirm=true to create a new Final Cut project");
    if (!request.confirmVerification) throw new Error("PUBLISH_VERIFICATION_CONFIRMATION_REQUIRED: separately confirm headed semantic readback before direct publish");
    if (request.sourceTransactionId.startsWith("headless-rough-cut:")) {
      throw new Error("HEADLESS_ROUGH_CUT_PUBLISH_JOB_REQUIRED: use artifact.publish.preview and artifact.publish.execute to preserve the approved target binding");
    }
    if (!this.readCanonicalSnapshot) {
      throw new Error("FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE: headed canonical timeline readback is not configured; no import was attempted");
    }
    const { source, identity } = await this.readValidatedSource(request);
    if (!this.liveState) {
      throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE: live project and sequence state is required");
    }
    if (!this.targetBinding) {
      throw new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted");
    }
    const targetLibraryPath = await validateTargetLibraryPath(
      request.targetLibraryPath,
      Boolean(this.documentDelivery) || request.sourceTransactionId.startsWith("headless-rough-cut:"),
    );
    const beforeLive = await readLiveState(this.liveState, "before import");
    const runtime: PublishJobRuntime = {
      beforeLive,
      identity,
      ...(targetLibraryPath ? { targetLibraryPath } : {}),
    };
    try {
      const result = await this.importAndVerify({ ...request, ...(targetLibraryPath ? { targetLibraryPath } : {}) }, source, identity, beforeLive, runtime);
      if (!result) throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_PENDING: separate verification is required");
      return result;
    } catch (error) {
      if (!runtime.importAttempted) throw error;

      const normalized = publishError(error);
      const job: FinalCutProjectPublishJob = {
        jobId: `publish-job-${randomUUID()}`,
        state: "verification-pending",
        nextAction: "retry",
        retryable: true,
        executionMode: "headed-only",
        sourceTransactionId: request.sourceTransactionId,
        sourcePath: this.sourcePath,
        sourceTarget: { kind: "artifact", artifactPath: this.sourcePath },
        artifactDigest: request.artifactDigest,
        ...(targetLibraryPath ? { targetLibraryPath } : {}),
        projectName: identity.projectName,
        sequenceName: identity.sequenceName,
        confirmationRequired: false,
        handoff: {
          mode: "headed-only",
          route: this.publishRoute,
          backgroundSupported: false,
          reason: "A direct publish may have reached Final Cut; verify this job before another import so its target reservation remains protected.",
        },
        error: normalized,
      };
      this.publishJobRuntime.set(job.jobId, runtime);
      this.persistPublishJob(job);
      throw new Error(`FINAL_CUT_PUBLISH_VERIFICATION_PENDING: publish job ${job.jobId} retained the target reservation; inspect with artifact.publish.status and resume with artifact.publish.execute (${normalized.message})`);
    }
  }

  private async readValidatedSource(
    request: FinalCutProjectPublishPreparationRequest,
  ): Promise<{
    source: string;
    identity: { projectName: string; sequenceName: string };
    sourceProof?: FinalCutHeadlessPublishSourceProof;
  }> {
    if (!request.sourceTransactionId.trim()) throw new Error("INVALID_PUBLISH_REQUEST: sourceTransactionId is required");
    if (!request.artifactDigest.trim()) throw new Error("INVALID_PUBLISH_REQUEST: artifactDigest is required");
    let sourceProof: FinalCutHeadlessPublishSourceProof | undefined;
    if (request.sourceTransactionId.startsWith("headless-rough-cut:")) {
      if (!this.headlessSourceVerifier) {
        throw new Error("HEADLESS_ROUGH_CUT_VERIFICATION_UNAVAILABLE: no approved headless source verifier is configured");
      }
      sourceProof = await this.headlessSourceVerifier(request);
      if (!sourceProof.targetLibraryUid.trim()) {
        throw new Error("HEADLESS_ROUGH_CUT_TARGET_INVALID: approved FCPXML has no explicit target library identity");
      }
      validateApprovedSourceMediaDigests(sourceProof.sourceMediaDigests);
    } else if (request.artifactPath !== this.sourcePath) {
      throw new Error(`PUBLISH_TARGET_MISMATCH: requested artifact ${request.artifactPath} is not managed by this publisher`);
    }
    const source = await readFile(request.artifactPath, "utf8");
    if (hash(source) !== request.artifactDigest) {
      throw new Error(sourceProof
        ? "HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED: approved FCPXML changed after execution verification"
        : "PUBLISH_SOURCE_CHANGED: managed FCPXML artifact changed after transaction verification");
    }
    if (!source.includes("<fcpxml") || !source.includes("<project")) {
      throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: source is not a valid FCPXML project artifact");
    }
    return {
      source,
      identity: projectIdentityFromXml(source),
      ...(sourceProof ? { sourceProof } : {}),
    };
  }

  private async importAndVerify(
    request: FinalCutProjectPublishRequest,
    source: string,
    identity: { projectName: string; sequenceName: string },
    beforeLive: EditorLiveState,
    runtime?: PublishJobRuntime,
    publishJob?: FinalCutProjectPublishJob,
  ): Promise<FinalCutProjectPublishResult | undefined> {
    if (!this.liveState) throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE: live project and sequence state is required");
    if (!this.targetBinding) throw new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted");
    if (!this.readCanonicalSnapshot) throw new Error("FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE: headed canonical timeline readback is not configured; no import was attempted");
    const route = publishJob?.handoff.route ?? this.publishRoute;
    const targetLibraryPath = await validateTargetLibraryPath(
      request.targetLibraryPath,
      Boolean(this.documentDelivery) || request.sourceTransactionId.startsWith("headless-rough-cut:"),
    );
    const expectedSnapshot = await new FcpxmlDocumentAdapter(request.artifactPath, undefined, {
      allowMissingImmutableIdsForReadback: true,
    }).readProject();
    const sourceMediaDigests = await captureSourceMediaDigests(expectedSnapshot);
    if (runtime?.approvedSourceMediaDigests) {
      assertSourceMediaMatchesApproval(sourceMediaDigests, runtime.approvedSourceMediaDigests);
    }
    if (hash(await readFile(request.artifactPath, "utf8")) !== request.artifactDigest) {
      throw new Error("PUBLISH_SOURCE_CHANGED: managed FCPXML artifact changed before import");
    }
    if (runtime) {
      runtime.expectedSnapshot = structuredClone(expectedSnapshot);
      runtime.sourceMediaDigests = structuredClone(sourceMediaDigests);
    }
    const directory = await mkdtemp(join(tmpdir(), "framekit-finalcut-publish-"));
    const importedPath = join(directory, basename(request.artifactPath));
    if (runtime) runtime.importedPath = importedPath;
    const importedSource = targetLibraryPath ? withLibraryLocationImportOption(source, targetLibraryPath) : source;
    const importedDigest = hash(importedSource);
    if (runtime) runtime.importedDigest = importedDigest;
    let delivery: FinalCutProjectPublishDelivery | undefined;
    try {
      await writeFile(importedPath, importedSource, "utf8");
      await validateTargetLibraryPath(targetLibraryPath, Boolean(this.documentDelivery));
      const reservation = targetLibraryPath ? await reserveTargetLibraryPath(targetLibraryPath) : undefined;
      if (runtime && reservation) {
        runtime.reservationPath = reservation.path;
        runtime.reservationId = reservation.id;
      }
      await validateTargetLibraryPath(targetLibraryPath, Boolean(this.documentDelivery));
      if (route === "headed-apple-event") {
        this.persistImportAttemptBeforeDispatch(publishJob, runtime);
        await this.executor(importXmlScript(importedPath));
        delivery = {
          status: "dispatched",
          route: "headed-apple-event",
          requestedActivates: true,
          activation: "activated",
          ui: "displayed",
          target: targetLibraryPath
            ? { requestedLibraryLocation: targetLibraryPath, guarantee: "requested-unverified" }
            : { guarantee: "unavailable" },
        };
      } else if (this.documentDelivery) {
        this.persistImportAttemptBeforeDispatch(publishJob, runtime);
        const dispatched = await this.documentDelivery.deliverFcpxml({
          artifactPath: importedPath,
          ...(targetLibraryPath ? { targetLibraryLocation: targetLibraryPath } : {}),
          activates: false,
        });
        if (runtime && dispatched.status !== "dispatched" && !dispatched.attempted) {
          runtime.importAttempted = false;
          this.persistRuntimeForJob(publishJob, runtime);
        }
        if (dispatched.status !== "dispatched") {
          const error = dispatched.error ?? {
            code: "FINAL_CUT_DELIVERY_USER_INTERACTION_REQUIRED",
            message: "Final Cut did not accept the background document-open request",
          };
          throw new Error(`${error.code}: ${error.message}`);
        }
        delivery = {
          status: "dispatched",
          route: dispatched.route,
          requestedActivates: dispatched.requestedActivates,
          activation: dispatched.activation,
          ui: dispatched.ui,
          target: dispatched.target,
        };
      } else {
        throw new Error("FINAL_CUT_DELIVERY_UNAVAILABLE: selected background document-open route is not configured; no import was attempted");
      }
      if (runtime) runtime.delivery = delivery;
      if (publishJob) publishJob.delivery = structuredClone(delivery);
      this.persistRuntimeForJob(publishJob, runtime);
      if (publishJob) return undefined;
      const verifiedTarget = await waitForImportedProject(
        this.liveState,
        async (targetPath, targetIdentity) => {
          return this.targetBinding!(targetPath, targetIdentity);
        },
        targetLibraryPath,
        identity,
        beforeLive,
        this.verificationTimeoutMs,
        this.pollIntervalMs,
      );
      await assertSourceMediaUnchanged(sourceMediaDigests);
      const semanticReadback = await this.readAndVerifyCanonicalTarget(
        expectedSnapshot,
        sourceMediaDigests,
        verifiedTarget.targetBinding,
        identity,
      );
      const result = publishResult(
        request,
        importedPath,
        importedDigest,
        identity,
        beforeLive,
        verifiedTarget.live,
        verifiedTarget.targetBinding,
        delivery,
        semanticReadback,
        sourceMediaDigests,
      );
      if (runtime) await releaseTargetLibraryReservation(runtime);
      return result;
    } catch (error) {
      if (!runtime?.importAttempted) {
        if (runtime) await releaseTargetLibraryReservation(runtime);
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async resumePublishVerification(job: FinalCutProjectPublishJob): Promise<FinalCutProjectPublishJob> {
    const runtime = this.publishJobRuntime.get(job.jobId);
    if (!runtime || !this.liveState) {
      return this.markAwaitingFinalCut(
        job,
        "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
        "Final Cut project state verification is unavailable; retry this job when the live provider is ready",
      );
    }
    if (!this.targetBinding) {
      return this.markFailed(job, new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no publish success was reported"));
    }
    if (!this.readCanonicalSnapshot || !runtime.expectedSnapshot || !runtime.sourceMediaDigests) {
      return this.markFailed(job, new Error("FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE: retained canonical readback evidence is missing; no publish success was reported"));
    }
    try {
      const verifiedTarget = await waitForImportedProject(
        this.liveState,
        (targetPath, identity) => this.targetBinding!(targetPath, identity),
        runtime.targetLibraryPath,
        runtime.identity,
        runtime.beforeLive,
        this.verificationTimeoutMs,
        this.pollIntervalMs,
      );
      job.observedTarget = structuredClone(verifiedTarget.targetBinding);
      this.persistPublishJob(job);
      await assertSourceMediaUnchanged(runtime.sourceMediaDigests);
      const semanticReadback = await this.readAndVerifyCanonicalTarget(
        runtime.expectedSnapshot,
        runtime.sourceMediaDigests,
        verifiedTarget.targetBinding,
        runtime.identity,
      );
      const result = publishResult(
        {
          sourceTransactionId: job.sourceTransactionId,
          artifactPath: job.sourcePath,
          artifactDigest: job.artifactDigest,
          ...(runtime.targetLibraryPath ? { targetLibraryPath: runtime.targetLibraryPath } : {}),
          confirm: true,
        },
        runtime.importedPath ?? job.sourcePath,
        runtime.importedDigest ?? job.artifactDigest,
        runtime.identity,
        runtime.beforeLive,
        verifiedTarget.live,
        verifiedTarget.targetBinding,
        runtime.delivery,
        semanticReadback,
        runtime.sourceMediaDigests,
      );
      await releaseTargetLibraryReservation(runtime);
      return this.markVerified(job, result);
    } catch (error) {
      job.state = "verification-pending";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = publishError(error);
      this.persistPublishJob(job);
      return clonePublishJob(job);
    }
  }

  private markVerified(job: FinalCutProjectPublishJob, result: FinalCutProjectPublishResult): FinalCutProjectPublishJob {
    job.state = "verified";
    job.nextAction = "none";
    job.retryable = false;
    job.createdTarget = structuredClone(result.createdTarget);
    job.result = structuredClone(result);
    delete job.error;
    this.persistPublishJob(job);
    return clonePublishJob(job);
  }

  private async readAndVerifyCanonicalTarget(
    expected: ProjectSnapshot,
    expectedMediaDigests: FinalCutPublishSourceMediaDigest[],
    targetBinding: FinalCutProjectPublishTargetBinding,
    identity: { projectName: string; sequenceName: string },
  ): Promise<FinalCutPublishReadbackEvidence> {
    if (!this.liveState || !this.readCanonicalSnapshot) {
      throw new Error("FINAL_CUT_PUBLISH_READBACK_UNAVAILABLE: headed canonical timeline readback is not configured");
    }
    const assertActiveTarget = async (phase: string): Promise<void> => {
      const live = await readLiveState(this.liveState!, phase);
      if (live.project?.id !== targetBinding.projectId
        || live.sequence?.id !== targetBinding.sequenceId
        || live.project.name !== identity.projectName
        || live.sequence.name !== identity.sequenceName) {
        throw new Error(`FINAL_CUT_PUBLISH_READBACK_TARGET_MISMATCH: exact created project and sequence are not active ${phase}`);
      }
    };
    await assertActiveTarget("before canonical export");
    const actual = await this.readCanonicalSnapshot(targetBinding, identity);
    await assertActiveTarget("after canonical export");
    const actualMediaDigests = await captureSourceMediaDigests(actual);
    assertPublishedMediaBindings(expectedMediaDigests, actualMediaDigests);
    const semanticReadback = verifyFinalCutPublishReadback(expected, actual, {
      expectedSourceMediaDigests: expectedMediaDigests,
      actualSourceMediaDigests: actualMediaDigests,
    });
    return semanticReadback;
  }

  private markAwaitingFinalCut(
    job: FinalCutProjectPublishJob,
    code: string,
    message: string,
  ): FinalCutProjectPublishJob {
    job.state = "awaiting-final-cut";
    job.nextAction = "retry";
    job.retryable = true;
    job.error = { code, message };
    this.persistPublishJob(job);
    return clonePublishJob(job);
  }

  private markFailed(job: FinalCutProjectPublishJob, error: unknown): FinalCutProjectPublishJob {
    job.state = "failed";
    job.nextAction = "none";
    job.retryable = false;
    job.error = publishError(error);
    this.persistPublishJob(job);
    return clonePublishJob(job);
  }

  private loadPersistedPublishJobs(): void {
    if (!this.publishJobsDirectory) return;
    mkdirSync(this.publishJobsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.publishJobsDirectory, 0o700);
    for (const name of readdirSync(this.publishJobsDirectory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.publishJobsDirectory, name);
      let persisted: PersistedPublishJob;
      try {
        persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedPublishJob;
      } catch (error) {
        throw new Error(`PUBLISH_JOB_STORE_INVALID: could not read ${path}`, { cause: error });
      }
      const job = persisted?.job;
      const validStates: FinalCutProjectPublishJobState[] = [
        "awaiting-confirmation",
        "awaiting-final-cut",
        "verification-pending",
        "verified",
        "failed",
      ];
      if (!persisted || persisted.version !== 1 || !job || typeof job.jobId !== "string"
        || !/^publish-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.jobId)
        || !validStates.includes(job.state) || name !== `${job.jobId}.json`) {
        throw new Error(`PUBLISH_JOB_STORE_INVALID: invalid publish job record ${path}`);
      }
      if (job.state === "verification-pending" && !persisted.runtime) {
        throw new Error(`PUBLISH_JOB_STORE_INVALID: pending job is missing recovery state ${path}`);
      }
      job.handoff.route ??= "background-document-open";
      if (job.handoff.route !== "background-document-open" && job.handoff.route !== "headed-apple-event") {
        throw new Error(`PUBLISH_JOB_STORE_INVALID: invalid publish route in ${path}`);
      }
      if (!job.delivery && persisted.runtime?.delivery) job.delivery = structuredClone(persisted.runtime.delivery);
      this.publishJobs.set(job.jobId, job);
      if (persisted.runtime) this.publishJobRuntime.set(job.jobId, persisted.runtime);
    }
  }

  private persistRuntimeForJob(job: FinalCutProjectPublishJob | undefined, runtime: PublishJobRuntime | undefined): void {
    if (!job || !runtime) return;
    this.persistPublishJob(job);
  }

  private persistImportAttemptBeforeDispatch(
    job: FinalCutProjectPublishJob | undefined,
    runtime: PublishJobRuntime | undefined,
  ): void {
    if (!runtime) return;
    runtime.importAttempted = true;
    try {
      this.persistRuntimeForJob(job, runtime);
    } catch (error) {
      runtime.importAttempted = false;
      throw error;
    }
  }

  private persistPublishJob(job: FinalCutProjectPublishJob): void {
    if (!this.publishJobsDirectory) {
      this.publishJobs.set(job.jobId, clonePublishJob(job));
      return;
    }
    if (!/^publish-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.jobId)) {
      throw new Error(`PUBLISH_JOB_STORE_INVALID: invalid publish job ID ${job.jobId}`);
    }
    mkdirSync(this.publishJobsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.publishJobsDirectory, 0o700);
    const path = join(this.publishJobsDirectory, `${job.jobId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const record: PersistedPublishJob = {
      version: 1,
      job: structuredClone(job),
      ...(this.publishJobRuntime.has(job.jobId)
        ? { runtime: structuredClone(this.publishJobRuntime.get(job.jobId)!) }
        : {}),
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.publishJobs.set(job.jobId, clonePublishJob(job));
  }
}

async function runAppleScript(script: string): Promise<string> {
  try {
    const result = await execFile("osascript", ["-e", script], { maxBuffer: 1_000_000 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
      throw new Error(`FINAL_CUT_NATIVE_PERMISSION_REQUIRED: ${detail}`);
    }
    throw new Error(`FINAL_CUT_PUBLISH_AUTOMATION_FAILED: ${detail}`);
  }
}

function importXmlScript(path: string): string {
  return `
tell application "Final Cut Pro"
  activate
  open POSIX file ${appleScriptString(path)}
end tell`;
}

function publishHandoffReason(route: FinalCutProjectPublishRoute): string {
  const verification = "After dispatch, Final Cut must expose the new project as the active target. The publisher verifies its native IDs, exports the active timeline through File > Export XML, and compares timeline semantics and source media digests before reporting success.";
  return route === "headed-apple-event"
    ? `The preview selects the headed AppleEvent route. It activates Final Cut Pro and opens the staged FCPXML with the approved library location. ${verification}`
    : `The preview selects the background document-open route and does not request activation. ${verification}`;
}

function projectIdentityFromXml(source: string): { projectName: string; sequenceName: string } {
  const projectMatch = source.match(/<project\b[^>]*\bname="([^"]+)"/);
  if (!projectMatch?.[1]) throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: FCPXML project has no name");
  const projectName = decodeXml(projectMatch[1]);
  const sequenceMatch = source.match(/<sequence\b[^>]*\bname="([^"]+)"/);
  return { projectName, sequenceName: sequenceMatch?.[1] ? decodeXml(sequenceMatch[1]) : projectName };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
}

async function readLiveState(
  liveState: () => Promise<EditorLiveState>,
  phase: string,
): Promise<EditorLiveState> {
  try {
    return await liveState();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL_CUT_PUBLISH_STATE_UNAVAILABLE: ${phase}: ${detail}`);
  }
}

async function waitForImportedProject(
  liveState: () => Promise<EditorLiveState>,
  resolveTargetBinding: (
    targetLibraryPath: string | undefined,
    identity: { projectName: string; sequenceName: string },
  ) => Promise<FinalCutProjectPublishTargetBinding>,
  targetLibraryPath: string | undefined,
  identity: { projectName: string; sequenceName: string },
  before: EditorLiveState,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ live: EditorLiveState; targetBinding: FinalCutProjectPublishTargetBinding }> {
  const deadline = Date.now() + timeoutMs;
  let latest: EditorLiveState | undefined;
  let lastError: unknown;
  let latestBinding: FinalCutProjectPublishTargetBinding | undefined;
  do {
    try {
      latest = await readLiveState(liveState, "after import");
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    try {
      latestBinding = await resolveTargetBinding(targetLibraryPath, identity);
      if (!latestBinding.projectId.trim() || !latestBinding.sequenceId.trim()) {
        throw new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: native target binding did not return project and sequence identities");
      }
      if (targetLibraryPath) {
        if (!latestBinding.libraryPath || normalizeLibraryPath(latestBinding.libraryPath) !== normalizeLibraryPath(targetLibraryPath)) {
          throw new Error(`FINAL_CUT_PUBLISH_TARGET_MISMATCH: expected library ${targetLibraryPath}, observed ${latestBinding.libraryPath ?? "unavailable"}`);
        }
        if (latest && isImportedProject(latest, identity, before, latestBinding)) {
          return { live: latest, targetBinding: latestBinding };
        }
      } else if (latest && isImportedProject(latest, identity, before, latestBinding)) {
        return { live: latest, targetBinding: latestBinding };
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (true);

  if (lastError) throw lastError;
  const observedProject = latest?.project?.name ?? "none";
  const observedSequence = latest?.sequence?.name ?? "none";
  if (latestBinding && latest?.project && latest.sequence
    && (latest.project.id !== latestBinding.projectId || latest.sequence.id !== latestBinding.sequenceId)) {
    throw new Error(
      `FINAL_CUT_PUBLISH_TARGET_MISMATCH: expected bound target ${latestBinding.projectId}/${latestBinding.sequenceId}, observed ${latest.project.id}/${latest.sequence.id}`,
    );
  }
  throw new Error(
    `FINAL_CUT_PUBLISH_VERIFICATION_FAILED: expected new project ${identity.projectName} / sequence ${identity.sequenceName}, observed ${observedProject} / ${observedSequence}`,
  );
}

function isImportedProject(
  live: EditorLiveState,
  identity: { projectName: string; sequenceName: string },
  before: EditorLiveState,
  targetBinding?: FinalCutProjectPublishTargetBinding,
): boolean {
  if (!live.project || !live.sequence) return false;
  if (live.project.name !== identity.projectName || live.sequence.name !== identity.sequenceName) return false;
  if (targetBinding
    && (live.project.id !== targetBinding.projectId || live.sequence.id !== targetBinding.sequenceId)) return false;
  if (before.project && live.project.id === before.project.id) return false;
  if (before.sequence && live.sequence.id === before.sequence.id) return false;
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function reserveTargetLibraryPath(targetLibraryPath: string): Promise<{ path: string; id: string }> {
  const requestedTarget = resolve(targetLibraryPath);
  const parent = await realpath(dirname(requestedTarget));
  const targetName = basename(requestedTarget).normalize("NFC");
  const canonicalTarget = join(parent, basename(requestedTarget));
  const reservationKey = join(parent, targetName);
  const normalizedKey = process.platform === "darwin" ? reservationKey.toLowerCase() : reservationKey;
  const reservationPath = join(parent, `.framekit-publish-${hash(normalizedKey)}.lock`);
  const reservationId = randomUUID();
  const reservationContents = JSON.stringify({
    reservationId,
    targetLibraryPath: canonicalTarget,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  try {
    await writeFile(reservationPath, reservationContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      const recovered = await recoverAbandonedTargetLibraryReservation(reservationPath, canonicalTarget, reservationContents);
      if (recovered) return { path: reservationPath, id: reservationId };
      throw new Error(`PUBLISH_TARGET_LIBRARY_RESERVED: another publisher is creating ${requestedTarget}`);
    }
    throw error;
  }
  return { path: reservationPath, id: reservationId };
}

async function recoverAbandonedTargetLibraryReservation(
  reservationPath: string,
  requestedTarget: string,
  nextReservationContents: string,
): Promise<boolean> {
  const recoveryPath = `${reservationPath}.recovery`;
  const recoveryId = randomUUID();
  const darwinExclusiveLock = process.platform === "darwin";
  // Darwin's O_EXLOCK is 0x20; the descriptor lock is released by the kernel if a publisher exits.
  const recoveryFlags = darwinExclusiveLock
    ? constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x20
    : "wx";
  let recoveryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    recoveryHandle = await open(recoveryPath, recoveryFlags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "EAGAIN" || code === "EWOULDBLOCK") return false;
    throw error;
  }
  if (!recoveryHandle) return false;

  try {
    if (!darwinExclusiveLock) {
      await recoveryHandle.writeFile(JSON.stringify({ recoveryId, pid: process.pid }));
    }
    return await reclaimAbandonedTargetLibraryReservation(
      reservationPath,
      requestedTarget,
      nextReservationContents,
    );
  } finally {
    await recoveryHandle.close();
    if (!darwinExclusiveLock) {
      try {
        const current = JSON.parse(await readFile(recoveryPath, "utf8")) as { recoveryId?: unknown };
        if (current.recoveryId === recoveryId) await rm(recoveryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
  }
}

async function reclaimAbandonedTargetLibraryReservation(
  reservationPath: string,
  requestedTarget: string,
  nextReservationContents: string,
): Promise<boolean> {
  let reservationStat;
  let reservationContents: string;
  try {
    reservationStat = await lstat(reservationPath);
    if (!reservationStat.isFile()) return false;
    reservationContents = await readFile(reservationPath, "utf8");
  } catch {
    return false;
  }

  let reservation: { reservationId?: unknown; targetLibraryPath?: unknown; pid?: unknown };
  try {
    reservation = JSON.parse(reservationContents) as typeof reservation;
  } catch {
    return false;
  }
  if (typeof reservation.reservationId !== "string" || !reservation.reservationId
    || typeof reservation.targetLibraryPath !== "string"
    || resolve(reservation.targetLibraryPath) !== requestedTarget
    || !Number.isSafeInteger(reservation.pid) || (reservation.pid as number) <= 0
    || processIsRunning(reservation.pid as number)) return false;

  try {
    await lstat(requestedTarget);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
  }

  let currentStat;
  let currentContents: string;
  try {
    currentStat = await lstat(reservationPath);
    currentContents = await readFile(reservationPath, "utf8");
  } catch {
    return false;
  }
  if (currentStat.dev !== reservationStat.dev || currentStat.ino !== reservationStat.ino || currentContents !== reservationContents) return false;

  try {
    await rm(reservationPath);
  } catch {
    return false;
  }
  try {
    await writeFile(reservationPath, nextReservationContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

async function releaseTargetLibraryReservation(runtime: PublishJobRuntime): Promise<void> {
  if (!runtime.reservationPath || !runtime.reservationId) return;
  const reservationPath = runtime.reservationPath;
  try {
    const contents = JSON.parse(await readFile(reservationPath, "utf8")) as { reservationId?: unknown };
    if (contents.reservationId === runtime.reservationId) {
      await rm(reservationPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(`PUBLISH_TARGET_RESERVATION_RELEASE_FAILED: could not release ${reservationPath}`);
    }
  }
  delete runtime.reservationPath;
  delete runtime.reservationId;
}

async function validateTargetLibraryPath(path: string | undefined, required: boolean): Promise<string | undefined> {
  if (!path?.trim()) {
    if (required) throw new Error("PUBLISH_TARGET_LIBRARY_REQUIRED: provide a new absolute .fcpbundle path for the imported project");
    return undefined;
  }
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".fcpbundle") {
    throw new Error("PUBLISH_TARGET_LIBRARY_INVALID: targetLibraryPath must be an absolute path ending in .fcpbundle");
  }
  const requestedTarget = resolve(path);
  try {
    await lstat(requestedTarget);
    throw new Error(`PUBLISH_TARGET_LIBRARY_EXISTS: target library already exists at ${requestedTarget}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PUBLISH_TARGET_LIBRARY_EXISTS:")) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  let parent: string;
  try {
    parent = await realpath(dirname(requestedTarget));
    await access(parent, constants.W_OK);
  } catch {
    throw new Error(`PUBLISH_TARGET_LIBRARY_PARENT_UNAVAILABLE: target library parent must exist and be writable: ${dirname(requestedTarget)}`);
  }
  const canonicalTarget = join(parent, basename(requestedTarget));
  try {
    await lstat(canonicalTarget);
    throw new Error(`PUBLISH_TARGET_LIBRARY_EXISTS: target library already exists at ${requestedTarget}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PUBLISH_TARGET_LIBRARY_EXISTS:")) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return requestedTarget;
}

function withLibraryLocationImportOption(source: string, targetLibraryPath: string): string {
  const opening = /<fcpxml\b[^>]*>/i.exec(source);
  const closing = /<\/fcpxml\s*>/ig;
  const closings = [...source.matchAll(closing)];
  if (!opening || closings.length !== 1 || (closings[0]?.index ?? -1) < opening.index + opening[0].length) {
    throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: source FCPXML must have one complete fcpxml root");
  }
  const bodyStart = opening.index + opening[0].length;
  const bodyEnd = closings[0]!.index!;
  const option = `<import-options><option key="library location" value="${escapeXmlAttribute(pathToFileURL(targetLibraryPath).href)}"/></import-options>`;
  const body = source.slice(bodyStart, bodyEnd);
  const existing = /<import-options\b([^>]*)>([\s\S]*?)<\/import-options\s*>/i;
  const selfClosing = /<import-options\b([^>]*)\/>/i;
  const existingMatch = existing.exec(body);
  const selfClosingMatch = existingMatch ? undefined : selfClosing.exec(body);
  let updatedBody: string;
  if (existingMatch) {
    const options = existingMatch[2] ?? "";
    const locationOption = /<option\b(?=[^>]*\bkey=(["'])library location\1)[^>]*(?:\/>|>[\s\S]*?<\/option\s*>)/i;
    const innerOption = option.slice("<import-options>".length, -"</import-options>".length);
    const updatedOptions = locationOption.test(options)
      ? options.replace(locationOption, () => innerOption)
      : `${innerOption}${options}`;
    updatedBody = body.replace(existing, () => `<import-options${existingMatch[1] ?? ""}>${updatedOptions}</import-options>`);
  } else if (selfClosingMatch) {
    updatedBody = body.replace(selfClosing, () => `<import-options${selfClosingMatch[1] ?? ""}>${option.slice("<import-options>".length, -"</import-options>".length)}</import-options>`);
  } else {
    updatedBody = `${option}${body}`;
  }
  return `${source.slice(0, bodyStart)}${updatedBody}${source.slice(bodyEnd)}`;
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeLibraryPath(path: string): string {
  try {
    const resolved = resolve(path.startsWith("file:") ? fileURLToPath(path) : path);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  } catch {
    return resolve(path);
  }
}

function clonePublishJob(job: FinalCutProjectPublishJob): FinalCutProjectPublishJob {
  return structuredClone(job);
}

function publishResult(
  request: FinalCutProjectPublishRequest,
  importedPath: string,
  importedDigest: string,
  identity: { projectName: string; sequenceName: string },
  beforeLive: EditorLiveState,
  live: EditorLiveState,
  targetBinding: FinalCutProjectPublishTargetBinding,
  delivery: FinalCutProjectPublishDelivery | undefined,
  semanticReadback: FinalCutPublishReadbackEvidence,
  sourceMediaDigests: FinalCutPublishSourceMediaDigest[] = [],
): FinalCutProjectPublishResult {
  return {
    sourceTransactionId: request.sourceTransactionId,
    sourcePath: request.artifactPath,
    sourceTarget: { kind: "artifact", artifactPath: request.artifactPath },
    importedPath,
    importedDigest,
    ...(request.targetLibraryPath ? { targetLibraryPath: request.targetLibraryPath } : {}),
    projectName: identity.projectName,
    createdTarget: {
      kind: "editor.project",
      projectId: targetBinding.projectId,
      sequenceId: targetBinding.sequenceId,
      ...(targetBinding.libraryId ? { libraryId: targetBinding.libraryId } : {}),
      ...(targetBinding.eventId ? { eventId: targetBinding.eventId } : {}),
      ...(targetBinding.libraryPath ? { libraryPath: targetBinding.libraryPath } : {}),
      projectName: identity.projectName,
      sequenceName: identity.sequenceName,
    },
    activeProject: {
      ...(beforeLive.project ? { before: beforeLive.project } : {}),
      ...(live.project ? { after: live.project } : {}),
      ...(beforeLive.project && live.project
        ? { changed: beforeLive.project.id !== live.project.id || beforeLive.project.name !== live.project.name }
        : {}),
    },
    verified: true,
    ...(delivery ? { delivery } : {}),
    semanticReadback,
    sourceMediaIntegrity: {
      unchanged: true,
      digests: structuredClone(sourceMediaDigests),
    },
    ...(live.project?.name ? { liveProject: live.project.name } : {}),
    ...(live.sequence?.name ? { liveSequence: live.sequence.name } : {}),
  };
}

async function captureSourceMediaDigests(snapshot: ProjectSnapshot): Promise<FinalCutPublishSourceMediaDigest[]> {
  const referencedMediaIds = new Set([
    ...snapshot.timeline.clips.map(({ mediaId }) => mediaId),
    ...snapshot.timeline.storyElements.map(({ mediaId }) => mediaId),
  ].filter((mediaId): mediaId is string => mediaId !== undefined));
  const sources = snapshot.media
    .filter(({ mediaId }) => referencedMediaIds.has(mediaId))
    .map(({ source }) => source);
  return captureSourceMediaPaths(sources);
}

async function captureSourceMediaPaths(sources: string[]): Promise<FinalCutPublishSourceMediaDigest[]> {
  const normalizedSources = [...new Set(sources.map((source) => resolve(source)))].sort();
  const digests: FinalCutPublishSourceMediaDigest[] = [];
  for (const source of normalizedSources) {
    try {
      const details = await stat(source);
      if (!details.isFile()) {
        throw new Error("source is not a regular file");
      }
      const hashStream = createHash("sha256");
      for await (const chunk of createReadStream(source)) hashStream.update(chunk);
      digests.push({ source, sha256: hashStream.digest("hex") });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`FINAL_CUT_PUBLISH_SOURCE_MEDIA_UNAVAILABLE: cannot verify ${source}: ${detail}`);
    }
  }
  return digests;
}

function validateApprovedSourceMediaDigests(digests: FinalCutPublishSourceMediaDigest[]): void {
  if (!Array.isArray(digests)) {
    throw new Error("HEADLESS_ROUGH_CUT_SOURCE_MEDIA_DIGEST_UNAVAILABLE: approved source media digests are missing");
  }
  const seenSources = new Set<string>();
  for (const item of digests) {
    if (!item || !isAbsolute(item.source) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error("HEADLESS_ROUGH_CUT_SOURCE_MEDIA_DIGEST_INVALID: approved source media digest is malformed");
    }
    const source = resolve(item.source);
    if (seenSources.has(source)) {
      throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MEDIA_DIGEST_INVALID: duplicate source ${source}`);
    }
    seenSources.add(source);
  }
}

function assertSourceMediaMatchesApproval(
  observed: FinalCutPublishSourceMediaDigest[],
  approved: FinalCutPublishSourceMediaDigest[],
): void {
  const normalized = (digests: FinalCutPublishSourceMediaDigest[]) => digests
    .map(({ source, sha256 }) => ({ source: resolve(source), sha256 }))
    .sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0);
  if (JSON.stringify(normalized(observed)) !== JSON.stringify(normalized(approved))) {
    throw new Error("HEADLESS_ROUGH_CUT_SOURCE_MEDIA_CHANGED: current source media do not match the approved rough-cut digests");
  }
}

async function assertSourceMediaUnchanged(expected: FinalCutPublishSourceMediaDigest[]): Promise<void> {
  let observed: FinalCutPublishSourceMediaDigest[];
  try {
    observed = await captureSourceMediaPaths(expected.map(({ source }) => source));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL_CUT_PUBLISH_SOURCE_MEDIA_CHANGED: ${detail}`);
  }
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("FINAL_CUT_PUBLISH_SOURCE_MEDIA_CHANGED: one or more source media digests changed during native publishing");
  }
}

function assertPublishedMediaBindings(
  expected: FinalCutPublishSourceMediaDigest[],
  actual: FinalCutPublishSourceMediaDigest[],
): void {
  const signature = (digests: FinalCutPublishSourceMediaDigest[]) => digests
    .map(({ source, sha256 }) => ({ name: basename(resolve(source)).normalize("NFC"), sha256 }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1
      : left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  if (JSON.stringify(signature(expected)) !== JSON.stringify(signature(actual))) {
    throw new Error("FINAL_CUT_PUBLISH_SOURCE_MEDIA_BINDING_MISMATCH: native library media do not match the approved source files");
  }
}

function publishError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(":");
  const code = separator > 0 ? message.slice(0, separator) : "FINAL_CUT_PUBLISH_FAILED";
  return { code, message };
}
