import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { TimelineIr } from "@framekit/runtime";
import { timelineIrDigest, validateTimelineIr } from "@framekit/runtime";
import type {
  FinalCutTargetIdentity,
  TimelineIrToFcpxmlResult,
  TimelineIrToFcpxmlTarget,
} from "./timeline-ir-fcpxml.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface FinalCutBackgroundMaterializationRequest {
  jobId: string;
  artifactPath: string;
  artifactDigest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  collisionPolicy: "create-only";
  desired: TimelineIr;
  desiredDigest: string;
}

export interface FinalCutBackgroundDeliveryProvenance {
  route: "document-open";
  activation: "not-activated" | "activated" | "unknown";
  interaction: "not-required" | "required" | "unknown";
}

export type FinalCutBackgroundMaterializationResult =
  | {
      state: "completed";
      canonicalReadback: TimelineIr;
      canonicalTarget: FinalCutTargetIdentity;
      headedNativeVerified: boolean;
      delivery?: FinalCutBackgroundDeliveryProvenance;
    }
  | { state: "blocked"; code: string; message: string; retryable: boolean };

export interface FinalCutBackgroundMaterializationPublisherOptions {
  executor?: (request: FinalCutBackgroundMaterializationRequest) => Promise<FinalCutBackgroundMaterializationResult>;
  command?: string;
  commandTimeoutMs?: number;
}

/**
 * Publishes an immutable FCPXML artifact through an explicit non-UI Final Cut
 * capability. The command owns Final Cut import and target-bound canonical
 * readback; this adapter never activates Final Cut or falls back to UI calls.
 */
export class FinalCutBackgroundMaterializationPublisher {
  private readonly commandTimeoutMs: number;

  public constructor(private readonly options: FinalCutBackgroundMaterializationPublisherOptions = {}) {
    if (options.commandTimeoutMs !== undefined && (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs <= 0)) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_TIMEOUT_INVALID: command timeout must be greater than zero");
    }
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  public isAvailable(): boolean {
    return this.options.executor !== undefined || Boolean(this.options.command?.trim());
  }

  public async publish(request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> {
    validateRequest(request);
    const executor = this.options.executor ?? (this.options.command?.trim()
      ? commandExecutor(this.options.command.trim(), this.commandTimeoutMs)
      : undefined);
    if (!executor) {
      return {
        state: "blocked",
        code: "FINAL_CUT_BACKGROUND_MATERIALIZATION_UNAVAILABLE",
        message: "No explicit non-UI Final Cut materialization capability is configured",
        retryable: true,
      };
    }

    const artifact = await readFile(request.artifactPath, "utf8");
    if (createHash("sha256").update(artifact).digest("hex") !== request.artifactDigest) {
      throw new Error("MATERIALIZATION_ARTIFACT_CHANGED: the staged FCPXML artifact no longer matches its immutable digest");
    }
    if (timelineIrDigest(request.desired) !== request.desiredDigest) {
      throw new Error("MATERIALIZATION_DESIRED_SNAPSHOT_INVALID: the staged desired Timeline IR digest is invalid");
    }
    const result = await executor({ ...request, desired: structuredClone(request.desired) });
    return validateResult(result);
  }
}

function validateRequest(request: FinalCutBackgroundMaterializationRequest): void {
  if (!request.jobId.trim()) throw new Error("MATERIALIZATION_REQUEST_INVALID: jobId is required");
  if (!request.artifactPath.trim() || !request.artifactDigest.trim()) {
    throw new Error("MATERIALIZATION_REQUEST_INVALID: immutable artifact path and digest are required");
  }
  if (!request.desiredDigest.trim()) throw new Error("MATERIALIZATION_REQUEST_INVALID: desired digest is required");
  if (request.collisionPolicy !== "create-only") throw new Error("MATERIALIZATION_REQUEST_INVALID: publication must be create-only");
  const { target } = request;
  if (target.provider !== "final-cut" || !target.libraryUid.trim() || !target.eventUid.trim() || !target.projectUid.trim() || !target.sequenceUid.trim()) {
    throw new Error("FCPXML_TARGET_BINDING_INVALID: library, event, project, and sequence identities are required");
  }
  if (request.destination.mode !== "versioned") {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_REUSE_FORBIDDEN: background publication cannot overwrite an existing project");
  }
  if (!request.destination.projectUid.trim() || !request.destination.sequenceUid.trim()) {
    throw new Error("MATERIALIZATION_DESTINATION_INVALID: versioned project and sequence identities are required");
  }
  validateTimelineIr(request.desired);
}

function validateResult(result: FinalCutBackgroundMaterializationResult): FinalCutBackgroundMaterializationResult {
  if (!result || (result.state !== "completed" && result.state !== "blocked")) {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: capability returned an invalid result");
  }
  if (result.state === "blocked") {
    if (typeof result.code !== "string" || typeof result.message !== "string" || !result.code.trim() || !result.message.trim()) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: blocked result is missing code or message");
    }
    return result;
  }
  validateTimelineIr(result.canonicalReadback);
  validateTargetIdentity(result.canonicalTarget);
  if (result.headedNativeVerified !== false) {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: background publisher cannot claim headed-native verification");
  }
  return result.state === "completed"
    ? {
        ...result,
        delivery: result.delivery ?? {
          route: "document-open",
          activation: "unknown",
          interaction: "unknown",
        },
      }
    : result;
}

function validateTargetIdentity(target: FinalCutTargetIdentity): void {
  if (!target || !target.libraryUid?.trim() || !target.eventUid?.trim() || !target.projectUid?.trim() || !target.sequenceUid?.trim()) {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: canonical target identity is incomplete");
  }
}

function commandExecutor(command: string, timeoutMs: number): (request: FinalCutBackgroundMaterializationRequest) => Promise<FinalCutBackgroundMaterializationResult> {
  return async (request) => {
    let output: string;
    try {
      output = await runCommand(command, request, timeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const timedOut = detail.startsWith("FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT");
      return {
        state: "blocked",
        code: timedOut
          ? "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT"
          : "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_UNAVAILABLE",
        message: detail,
        retryable: true,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
    }
    return validateResult(parsed as FinalCutBackgroundMaterializationResult);
  };
}

function runCommand(
  command: string,
  request: FinalCutBackgroundMaterializationRequest,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let forceKillHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (forceKillHandle !== undefined) clearTimeout(forceKillHandle);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => {
      closed = true;
      if (settled) {
        cleanup();
        return;
      }
      if (code === 0) {
        settle(() => resolve(stdout));
      } else {
        settle(() => reject(new Error(
          `FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_FAILED: command exited ${code}: ${stderr.trim()}`,
        )));
      }
    });
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      forceKillHandle = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 1_000);
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      reject(new Error(
        `FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT: command exceeded ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
