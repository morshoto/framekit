import { execFile as execFileCallback } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EditorLiveState } from "@framekit/runtime";
import type { FinalCutFcpxmlDelivery } from "./live.js";

const execFile = promisify(execFileCallback);

export interface FinalCutProjectPublishDelivery {
  status: "dispatched";
  route: "background-document-open" | "headed-accessibility";
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

export type FinalCutProjectPublishJobState =
  | "awaiting-confirmation"
  | "awaiting-final-cut"
  | "verification-pending"
  | "verified"
  | "failed";

export type FinalCutProjectPublishJobAction = "confirm" | "retry" | "status" | "none";

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
    backgroundSupported: boolean;
    reason: string;
  };
  createdTarget?: FinalCutProjectPublishResult["createdTarget"];
  result?: FinalCutProjectPublishResult;
  error?: {
    code: string;
    message: string;
  };
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
  /** Opens the staged FCPXML through the native Workflow Extension bridge. */
  documentDelivery?: {
    deliverFcpxml(request: { artifactPath: string; targetLibraryLocation?: string; activates: boolean }): Promise<FinalCutFcpxmlDelivery>;
  };
  /** Explicitly permits the legacy Accessibility import after a native delivery blocker. */
  allowHeadedFallback?: boolean;
  verificationTimeoutMs?: number;
  pollIntervalMs?: number;
  /** @deprecated Use pollIntervalMs. */
  waitMs?: number;
}

interface PublishJobRuntime {
  beforeLive: EditorLiveState;
  identity: { projectName: string; sequenceName: string };
  targetLibraryPath?: string;
  importedPath?: string;
  importedDigest?: string;
  delivery?: FinalCutProjectPublishDelivery;
}

/** Imports a validated FCPXML artifact as a new Final Cut project. */
export class FinalCutProjectPublisher {
  private readonly enabled: boolean;
  private readonly sourcePath: string;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly targetBinding?: FinalCutProjectPublisherOptions["targetBinding"];
  private readonly documentDelivery?: FinalCutProjectPublisherOptions["documentDelivery"];
  private readonly allowHeadedFallback: boolean;
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
    this.documentDelivery = options.documentDelivery;
    this.allowHeadedFallback = options.allowHeadedFallback ?? false;
    this.verificationTimeoutMs = Math.max(0, options.verificationTimeoutMs ?? 15_000);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? options.waitMs ?? 100);
  }

  public isAvailable(): boolean {
    return this.enabled && Boolean(this.liveState && this.targetBinding);
  }

  public executionMode(): "background-capable" | "headed-only" {
    return this.documentDelivery ? "background-capable" : "headed-only";
  }

  public async preparePublish(
    request: FinalCutProjectPublishPreparationRequest,
  ): Promise<FinalCutProjectPublishJob> {
    const { identity } = await this.readValidatedSource(request);
    const targetLibraryPath = await validateTargetLibraryPath(request.targetLibraryPath, Boolean(this.documentDelivery));
    const job: FinalCutProjectPublishJob = {
      jobId: `publish-job-${randomUUID()}`,
      state: "awaiting-confirmation",
      nextAction: "confirm",
      retryable: false,
      executionMode: this.documentDelivery ? "background-capable" : "headed-only",
      sourceTransactionId: request.sourceTransactionId,
      sourcePath: this.sourcePath,
      sourceTarget: { kind: "artifact", artifactPath: this.sourcePath },
      artifactDigest: request.artifactDigest,
      ...(targetLibraryPath ? { targetLibraryPath } : {}),
      projectName: identity.projectName,
      sequenceName: identity.sequenceName,
      confirmationRequired: true,
      handoff: {
        mode: this.documentDelivery ? "background-document-open" : "headed-only",
        backgroundSupported: Boolean(this.documentDelivery),
        reason: this.documentDelivery
          ? "Opens the approved FCPXML through the native document-open bridge with an explicit new library location; a separate catalog readback must bind the created project before success."
          : "Final Cut has no supported non-UI project publishing contract; use the explicit headed handoff and verify the created target.",
      },
    };
    this.publishJobs.set(job.jobId, job);
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
  ): Promise<FinalCutProjectPublishJob> {
    const job = this.publishJobs.get(jobId);
    if (!job) throw new Error(`PUBLISH_JOB_NOT_FOUND: unknown publish job ${jobId}`);
    if (job.state === "verified") return clonePublishJob(job);
    if (job.state === "failed" && !job.retryable) return clonePublishJob(job);
    if (!confirm) throw new Error("PUBLISH_CONFIRMATION_REQUIRED: set confirm=true to create a new Final Cut project");

    if (!this.enabled) {
      job.state = "awaiting-final-cut";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = {
        code: "CAPABILITY_UNAVAILABLE",
        message: "Final Cut project publishing is unavailable; bring Final Cut Pro to the front and retry this job",
      };
      return clonePublishJob(job);
    }

    if (!this.liveState) return this.markAwaitingFinalCut(
      job,
      "FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE",
      "Final Cut project state verification is unavailable; retry this job when the live provider is ready",
    );

    if (job.state === "verification-pending") return this.resumePublishVerification(job);

    let validated: Awaited<ReturnType<FinalCutProjectPublisher["readValidatedSource"]>>;
    try {
      validated = await this.readValidatedSource({
        sourceTransactionId: job.sourceTransactionId,
        artifactPath: job.sourcePath,
        artifactDigest: job.artifactDigest,
        ...(job.targetLibraryPath ? { targetLibraryPath: job.targetLibraryPath } : {}),
      });
      await validateTargetLibraryPath(job.targetLibraryPath, Boolean(this.documentDelivery));
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
    };
    this.publishJobRuntime.set(job.jobId, runtime);
    job.state = "verification-pending";
    job.nextAction = "status";
    job.retryable = false;
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
      );
      return this.markVerified(job, result);
    } catch (error) {
      job.state = "verification-pending";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = publishError(error);
      return clonePublishJob(job);
    }
  }

  public async publishNewProject(request: FinalCutProjectPublishRequest): Promise<FinalCutProjectPublishResult> {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing is disabled; configure FRAMEKIT_EDITOR=final-cut-live and FRAMEKIT_FCPXML_PATH, and ensure Final Cut is reachable through FRAMEKIT_FINAL_CUT_SOCKET");
    if (!request.confirm) throw new Error("PUBLISH_CONFIRMATION_REQUIRED: set confirm=true to create a new Final Cut project");
    const { source, identity } = await this.readValidatedSource(request);
    if (!this.liveState) {
      throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE: live project and sequence state is required");
    }
    if (!this.targetBinding) {
      throw new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted");
    }
    const targetLibraryPath = await validateTargetLibraryPath(request.targetLibraryPath, Boolean(this.documentDelivery));
    const beforeLive = await readLiveState(this.liveState, "before import");
    const runtime: PublishJobRuntime = {
      beforeLive,
      identity,
      ...(targetLibraryPath ? { targetLibraryPath } : {}),
    };
    return this.importAndVerify({ ...request, ...(targetLibraryPath ? { targetLibraryPath } : {}) }, source, identity, beforeLive, runtime);
  }

  private async readValidatedSource(
    request: FinalCutProjectPublishPreparationRequest,
  ): Promise<{ source: string; identity: { projectName: string; sequenceName: string } }> {
    if (!request.sourceTransactionId.trim()) throw new Error("INVALID_PUBLISH_REQUEST: sourceTransactionId is required");
    if (!request.artifactDigest.trim()) throw new Error("INVALID_PUBLISH_REQUEST: artifactDigest is required");
    if (request.artifactPath !== this.sourcePath) {
      throw new Error(`PUBLISH_TARGET_MISMATCH: requested artifact ${request.artifactPath} is not managed by this publisher`);
    }
    const source = await readFile(this.sourcePath, "utf8");
    if (hash(source) !== request.artifactDigest) {
      throw new Error("PUBLISH_SOURCE_CHANGED: managed FCPXML artifact changed after transaction verification");
    }
    if (!source.includes("<fcpxml") || !source.includes("<project")) {
      throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: source is not a valid FCPXML project artifact");
    }
    return { source, identity: projectIdentityFromXml(source) };
  }

  private async importAndVerify(
    request: FinalCutProjectPublishRequest,
    source: string,
    identity: { projectName: string; sequenceName: string },
    beforeLive: EditorLiveState,
    runtime?: PublishJobRuntime,
  ): Promise<FinalCutProjectPublishResult> {
    if (!this.liveState) throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE: live project and sequence state is required");
    if (!this.targetBinding) throw new Error("FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE: no native provider can bind the imported artifact to a created target; no import was attempted");
    const targetLibraryPath = await validateTargetLibraryPath(request.targetLibraryPath, Boolean(this.documentDelivery));
    const directory = await mkdtemp(join(tmpdir(), "framekit-finalcut-publish-"));
    const importedPath = join(directory, basename(this.sourcePath));
    if (runtime) runtime.importedPath = importedPath;
    const importedSource = targetLibraryPath ? withLibraryLocationImportOption(source, targetLibraryPath) : source;
    const importedDigest = hash(importedSource);
    if (runtime) runtime.importedDigest = importedDigest;
    let delivery: FinalCutProjectPublishDelivery | undefined;
    try {
      await writeFile(importedPath, importedSource, "utf8");
      await validateTargetLibraryPath(targetLibraryPath, Boolean(this.documentDelivery));
      if (this.documentDelivery) {
        const dispatched = await this.documentDelivery.deliverFcpxml({
          artifactPath: importedPath,
          ...(targetLibraryPath ? { targetLibraryLocation: targetLibraryPath } : {}),
          activates: false,
        });
        if (dispatched.status !== "dispatched" && !this.allowHeadedFallback) {
          const error = dispatched.error ?? {
            code: "FINAL_CUT_DELIVERY_USER_INTERACTION_REQUIRED",
            message: "Final Cut did not accept the background document-open request",
          };
          throw new Error(`${error.code}: ${error.message}`);
        }
        if (dispatched.status === "dispatched") {
          delivery = {
            status: "dispatched",
            route: dispatched.route,
            requestedActivates: dispatched.requestedActivates,
            activation: dispatched.activation,
            ui: dispatched.ui,
            target: dispatched.target,
          };
        } else {
          await this.executor(importXmlScript(importedPath));
          delivery = {
            status: "dispatched",
            route: "headed-accessibility",
            requestedActivates: true,
            activation: "activated",
            ui: "displayed",
            target: dispatched.target,
          };
        }
      } else {
        await this.executor(importXmlScript(importedPath));
        delivery = {
          status: "dispatched",
          route: "headed-accessibility",
          requestedActivates: true,
          activation: "activated",
          ui: "displayed",
          target: { guarantee: "unavailable" },
        };
      }
      if (runtime) runtime.delivery = delivery;
      const verifiedTarget = await waitForImportedProject(
        this.liveState,
        (targetPath, targetIdentity) => this.targetBinding!(targetPath, targetIdentity),
        targetLibraryPath,
        identity,
        beforeLive,
        this.verificationTimeoutMs,
        this.pollIntervalMs,
      );
      return publishResult(
        request,
        importedPath,
        importedDigest,
        identity,
        beforeLive,
        verifiedTarget.live,
        verifiedTarget.targetBinding,
        delivery,
      );
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
      );
      return this.markVerified(job, result);
    } catch (error) {
      job.state = "verification-pending";
      job.nextAction = "retry";
      job.retryable = true;
      job.error = publishError(error);
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
    return clonePublishJob(job);
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
    return clonePublishJob(job);
  }

  private markFailed(job: FinalCutProjectPublishJob, error: unknown): FinalCutProjectPublishJob {
    job.state = "failed";
    job.nextAction = "none";
    job.retryable = false;
    job.error = publishError(error);
    return clonePublishJob(job);
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
using terms from application "System Events"

on waitForMenuItem(container, expectedNames, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    repeat with candidate in (menu items of container)
      try
        set candidateName to name of candidate as text
        repeat with expectedName in expectedNames
          if candidateName is (expectedName as text) then return candidate
        end repeat
      end try
    end repeat
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end waitForMenuItem

on waitForSubmenu(menuItem, submenuName, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists menu submenuName of menuItem then return menu submenuName of menuItem
    end try
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end waitForSubmenu

on waitForWindow(finalCut, windowName, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists window windowName of finalCut then return window windowName of finalCut
    end try
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end waitForWindow

on waitForImportSheet(importWindow, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists sheet 1 of importWindow then return sheet 1 of importWindow
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_SHEET_TIMEOUT: Import XML sheet did not appear"
    delay 0.1
  end repeat
end waitForImportSheet

on matchesImportPathField(candidate)
  set candidateIdentifier to ""
  set candidateDescription to ""
  try
    set candidateIdentifier to value of attribute "AXIdentifier" of candidate as text
  end try
  try
    set candidateDescription to description of candidate as text
  end try
  if candidateIdentifier is "path" or candidateIdentifier is "location" then return true
  if candidateDescription contains "Go to the folder" then return true
  if candidateDescription contains "path" or candidateDescription contains "location" then return true
  return false
end matchesImportPathField

on locateImportPathField(pathSheet)
  set matchingFields to {}
  repeat with candidate in (text fields of pathSheet)
    if matchesImportPathField(candidate) then set end of matchingFields to candidate
  end repeat
  if (count of matchingFields) is 0 then error "FINAL_CUT_PUBLISH_PATH_CONTROL_UNAVAILABLE: Import XML path control had no accessibility identifier or description"
  if (count of matchingFields) is not 1 then error "FINAL_CUT_PUBLISH_PATH_CONTROL_AMBIGUOUS: Import XML path control was not unique"
  return item 1 of matchingFields
end locateImportPathField

on waitForImportSheetDismissal(importWindow, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if not (exists sheet 1 of importWindow) then return
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_SHEET_DISMISS_TIMEOUT: Import XML sheet did not disappear"
    delay 0.1
  end repeat
end waitForImportSheetDismissal

on waitForImportWindowDismissal(finalCut, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if not (exists window "Import XML" of finalCut) then return
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_TIMEOUT: Import XML window did not close"
    delay 0.1
  end repeat
end waitForImportWindowDismissal

on cancelImportIfOpen(finalCut)
  try
    if exists window "Import XML" of finalCut then
      set importWindow to window "Import XML" of finalCut
      repeat with candidate in (buttons of importWindow)
        try
          if (name of candidate as text) is "Cancel" then
            perform action "AXPress" of candidate
            exit repeat
          end if
        end try
      end repeat
    end if
  end try
end cancelImportIfOpen

end using terms from

tell application "System Events"
  tell process "Final Cut Pro"
    set finalCut to it
    set importWindow to missing value
    try
      if not frontmost then error number -1719
      set fileMenu to menu "File" of menu bar 1
      set importMenuItem to my waitForMenuItem(fileMenu, {"Import"}, 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: File > Import was not exposed")
      perform action "AXPress" of importMenuItem
      set importMenu to my waitForSubmenu(importMenuItem, "Import", 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: Import submenu was not exposed")
      set xmlMenuItem to my waitForMenuItem(importMenu, {"XML…", "XML..."}, 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: Import XML command was not exposed")
      perform action "AXPress" of xmlMenuItem
      set importWindow to my waitForWindow(finalCut, "Import XML", 10, "FINAL_CUT_PUBLISH_IMPORT_SHEET_TIMEOUT: Import XML sheet did not appear")
      keystroke "g" using {command down, shift down}
      set pathSheet to my waitForImportSheet(importWindow, 10)
      set pathField to my locateImportPathField(pathSheet)
      set value of pathField to ${appleScriptString(path)}
      key code 36
      my waitForImportSheetDismissal(importWindow, 10)
      key code 36
      my waitForImportWindowDismissal(finalCut, 60)
    on error errorMessage number errorNumber
      my cancelImportIfOpen(finalCut)
      error errorMessage number errorNumber
    end try
  end tell
end tell`;
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
  delivery?: FinalCutProjectPublishDelivery,
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
    ...(live.project?.name ? { liveProject: live.project.name } : {}),
    ...(live.sequence?.name ? { liveSequence: live.sequence.name } : {}),
  };
}

function publishError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(":");
  const code = separator > 0 ? message.slice(0, separator) : "FINAL_CUT_PUBLISH_FAILED";
  return { code, message };
}
