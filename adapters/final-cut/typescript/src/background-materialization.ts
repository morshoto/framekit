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

export type FinalCutBackgroundMaterializationResult =
  | {
      state: "completed";
      canonicalReadback: TimelineIr;
      canonicalTarget: FinalCutTargetIdentity;
      headedNativeVerified: boolean;
    }
  | { state: "blocked"; code: string; message: string; retryable: boolean };

export interface FinalCutBackgroundMaterializationPublisherOptions {
  executor?: (request: FinalCutBackgroundMaterializationRequest) => Promise<FinalCutBackgroundMaterializationResult>;
  command?: string;
}

/**
 * Publishes an immutable FCPXML artifact through an explicit non-UI Final Cut
 * capability. The command owns Final Cut import and target-bound canonical
 * readback; this adapter never activates Final Cut or falls back to UI calls.
 */
export class FinalCutBackgroundMaterializationPublisher {
  public constructor(private readonly options: FinalCutBackgroundMaterializationPublisherOptions = {}) {}

  public isAvailable(): boolean {
    return this.options.executor !== undefined || Boolean(this.options.command?.trim());
  }

  public async publish(request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> {
    validateRequest(request);
    const executor = this.options.executor ?? (this.options.command?.trim()
      ? commandExecutor(this.options.command.trim())
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
    if (typeof result.code !== "string" || typeof result.message !== "string" || typeof result.retryable !== "boolean" || !result.code.trim() || !result.message.trim()) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: blocked result is missing code, message, or retryability");
    }
    return result;
  }
  validateTimelineIr(result.canonicalReadback);
  validateTargetIdentity(result.canonicalTarget);
  if (result.headedNativeVerified !== false) {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: background publisher cannot claim headed-native verification");
  }
  return result;
}

function validateTargetIdentity(target: FinalCutTargetIdentity): void {
  if (!target || !target.libraryUid?.trim() || !target.eventUid?.trim() || !target.projectUid?.trim() || !target.sequenceUid?.trim()) {
    throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: canonical target identity is incomplete");
  }
}

function commandExecutor(command: string): (request: FinalCutBackgroundMaterializationRequest) => Promise<FinalCutBackgroundMaterializationResult> {
  return async (request) => {
    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolvePromise(stdout);
        else reject(new Error(`FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_FAILED: command exited ${code}: ${stderr.trim()}`));
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
    }
    return validateResult(parsed as FinalCutBackgroundMaterializationResult);
  };
}
