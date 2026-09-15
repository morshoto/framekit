import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { TimelineIr } from "@framekit/runtime";
import type { TimelineIrToFcpxmlResult, TimelineIrToFcpxmlTarget } from "./timeline-ir-fcpxml.js";

export interface FinalCutBackgroundMaterializationRequest {
  jobId: string;
  artifactPath: string;
  artifactDigest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  desired: TimelineIr;
}

export type FinalCutBackgroundMaterializationResult =
  | { state: "completed"; canonicalReadback: TimelineIr; headedNativeVerified: boolean }
  | { state: "blocked"; code: string; message: string; retryable: boolean };

export interface FinalCutBackgroundMaterializationPublisherOptions {
  executor?: (request: FinalCutBackgroundMaterializationRequest) => Promise<FinalCutBackgroundMaterializationResult>;
  command?: string;
}

/**
 * Delegates a staged FCPXML artifact to an explicitly configured non-UI Final
 * Cut capability. It verifies the artifact immediately before delegation and
 * never falls back to AppleScript or UI activation.
 */
export class FinalCutBackgroundMaterializationPublisher {
  public constructor(private readonly options: FinalCutBackgroundMaterializationPublisherOptions = {}) {}

  public isAvailable(): boolean {
    return this.options.executor !== undefined || Boolean(this.options.command?.trim());
  }

  public async publish(request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> {
    const executor = this.options.executor ?? (this.options.command ? commandExecutor(this.options.command) : undefined);
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
    return executor({ ...request, desired: structuredClone(request.desired) });
  }
}

function commandExecutor(command: string) {
  return async (request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> => {
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
    const result = JSON.parse(output) as FinalCutBackgroundMaterializationResult;
    if (!result || (result.state !== "completed" && result.state !== "blocked")) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: command returned an invalid result");
    }
    if (result.state === "completed" && result.headedNativeVerified) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID: background publisher cannot claim headed-native verification");
    }
    return result;
  };
}
