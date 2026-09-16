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
  commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Delegates a staged FCPXML artifact to an explicitly configured non-UI Final
 * Cut capability. It verifies the artifact immediately before delegation and
 * never falls back to AppleScript or UI activation.
 */
export class FinalCutBackgroundMaterializationPublisher {
  private readonly commandTimeoutMs: number;

  public constructor(private readonly options: FinalCutBackgroundMaterializationPublisherOptions = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error("FINAL_CUT_BACKGROUND_MATERIALIZATION_TIMEOUT_INVALID: commandTimeoutMs must be greater than zero");
    }
  }

  public isAvailable(): boolean {
    return this.options.executor !== undefined || Boolean(this.options.command?.trim());
  }

  public async publish(request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> {
    const executor = this.options.executor ?? (this.options.command
      ? commandExecutor(this.options.command, this.commandTimeoutMs)
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
    return executor({ ...request, desired: structuredClone(request.desired) });
  }
}

function commandExecutor(command: string, timeoutMs: number) {
  return async (request: FinalCutBackgroundMaterializationRequest): Promise<FinalCutBackgroundMaterializationResult> => {
    let output: string;
    try {
      output = await runCommand(command, request, timeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        state: "blocked",
        code: detail.startsWith("FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT")
          ? "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT"
          : "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_UNAVAILABLE",
        message: `The configured non-UI Final Cut materialization command could not complete: ${detail}`,
        retryable: true,
      };
    }
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

function runCommand(
  command: string,
  request: FinalCutBackgroundMaterializationRequest,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => settle(() => rejectPromise(error)));
    child.once("close", (code) => {
      settle(() => {
        if (code === 0) resolvePromise(stdout);
        else rejectPromise(new Error(`FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_FAILED: command exited ${code}: ${stderr.trim()}`));
      });
    });
    timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT: command exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
