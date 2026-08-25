import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, constants, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { NativeFinalCutContext } from "./native.js";
import type { NativeOperationLease } from "./native-operation.js";

const execFile = promisify(execFileCallback);

export const FINAL_CUT_EXPORT_PRESETS = {
  master: { menuItem: "Export File" },
  web: { menuItem: "Web Hosting" },
} as const;

export type FinalCutExportPreset = keyof typeof FINAL_CUT_EXPORT_PRESETS;

export interface FinalCutVideoExportExpectation {
  durationSeconds?: number;
  durationToleranceSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  frameRateTolerance?: number;
  hasAudio?: boolean;
}

export interface FinalCutVideoExportRequest {
  outputPath: string;
  preset: FinalCutExportPreset;
  overwrite?: boolean;
  expected?: FinalCutVideoExportExpectation;
}

export interface FinalCutVideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface FinalCutVideoMetadata extends FinalCutVideoProbeResult {
  outputPath: string;
  sizeBytes: number;
}

export interface FinalCutVideoExportResult {
  outputPath: string;
  preset: FinalCutExportPreset;
  completed: true;
  verified: true;
  metadata: FinalCutVideoMetadata;
}

export interface FinalCutVideoExporterOptions {
  enabled?: boolean;
  executor?: (script: string) => Promise<string>;
  preflight?: () => Promise<NativeFinalCutContext>;
  probe?: (outputPath: string) => Promise<FinalCutVideoProbeResult>;
  probeAvailability?: () => Promise<boolean>;
  probeAvailable?: boolean;
  waitMs?: number;
  pollMs?: number;
  stablePolls?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nativeOperationLease?: NativeOperationLease;
  suspendLiveConnection?: () => void;
  resumeLiveConnection?: () => void;
}

export async function isFinalCutVideoProbeAvailable(): Promise<boolean> {
  try {
    await execFile("ffprobe", ["-version"], { maxBuffer: 1_000_000 });
    return true;
  } catch {
    return false;
  }
}

/** Exports the active Final Cut timeline and verifies the resulting media file. */
export class FinalCutVideoExporter {
  private readonly enabled: boolean;
  private readonly executor: (script: string) => Promise<string>;
  private readonly preflight?: () => Promise<NativeFinalCutContext>;
  private readonly probe: (outputPath: string) => Promise<FinalCutVideoProbeResult>;
  private readonly probeAvailability?: () => Promise<boolean>;
  private readonly probeAvailable: boolean;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly stablePolls: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nativeOperationLease?: NativeOperationLease;
  private readonly suspendLiveConnection?: () => void;
  private readonly resumeLiveConnection?: () => void;

  public constructor(options: FinalCutVideoExporterOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.executor = options.executor ?? runAppleScript;
    this.preflight = options.preflight;
    this.probe = options.probe ?? probeWithFfprobe;
    this.probeAvailability = options.probeAvailability ?? (options.probe ? undefined : isFinalCutVideoProbeAvailable);
    this.probeAvailable = options.probeAvailable ?? true;
    this.waitMs = options.waitMs ?? 120_000;
    this.pollMs = options.pollMs ?? 250;
    this.stablePolls = Math.max(1, Math.floor(options.stablePolls ?? 2));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.nativeOperationLease = options.nativeOperationLease;
    this.suspendLiveConnection = options.suspendLiveConnection;
    this.resumeLiveConnection = options.resumeLiveConnection;
  }

  public isAvailable(): boolean {
    return this.enabled && this.probeAvailable;
  }

  public async exportVideo(request: FinalCutVideoExportRequest): Promise<FinalCutVideoExportResult> {
    if (!this.enabled) {
      throw new Error("CAPABILITY_UNAVAILABLE: Final Cut video export is disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    }
    if (!request.outputPath.trim()) throw new Error("INVALID_EXPORT: outputPath is required");
    if (!this.isAvailable()) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut video export metadata probing is unavailable");
    const outputPath = resolve(request.outputPath.trim());
    const preset = FINAL_CUT_EXPORT_PRESETS[request.preset];
    if (!preset) throw new Error(`INVALID_EXPORT_PRESET: unsupported Final Cut export preset ${String(request.preset)}`);
    validateExpectation(request.expected);
    if (this.probeAvailability && !(await this.probeAvailability())) {
      throw new Error("FINAL_CUT_EXPORT_METADATA_UNAVAILABLE: ffprobe is required to verify exported video metadata");
    }
    await assertOutputDirectory(outputPath);
    await assertOutputCanBeReplaced(outputPath, request.overwrite ?? false);
    const stagingPath = createStagingPath(outputPath);
    let committed = false;

    try {
      const result = await this.withNativeUi(async () => {
        await this.assertPreflight();
        await this.executor(exportScript(stagingPath, preset.menuItem));
        const output = await this.waitForOutput(stagingPath);
        const probed = await this.probeUntilReady(stagingPath, output.deadline);
        const metadata: FinalCutVideoMetadata = {
          outputPath,
          sizeBytes: output.size,
          ...probed,
        };
        verifyMetadata(metadata, request.expected);
        await commitOutput(stagingPath, outputPath, request.overwrite ?? false);
        committed = true;
        return {
          outputPath,
          preset: request.preset,
          completed: true as const,
          verified: true as const,
          metadata,
        };
      });
      return result;
    } finally {
      if (!committed) await removeIfPresent(stagingPath);
    }
  }

  private async assertPreflight(): Promise<void> {
    if (!this.preflight) return;
    const context = await this.preflight();
    if (!context.available) {
      throw new Error(`${context.error?.code ?? "FINAL_CUT_NATIVE_UNAVAILABLE"}: ${context.error?.message ?? "native Final Cut context unavailable"}`);
    }
    if (!context.timelineWindowAvailable) {
      throw new Error("FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW: Final Cut has no accessible timeline window; open a project timeline and retry");
    }
    if (!context.frontmost) {
      throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut is running but is not the frontmost application");
    }
    if (!context.timelineFocused) {
      throw new Error("FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED: Final Cut's timeline pane could not be focused; click the timeline and retry");
    }
  }

  private async waitForOutput(outputPath: string): Promise<{ size: number; deadline: number }> {
    const deadline = this.now() + this.waitMs;
    let previous: { size: number; mtimeMs: number } | undefined;
    let stableObservations = 0;
    while (true) {
      try {
        const details = await stat(outputPath);
        if (details.isFile() && details.size > 0) {
          const current = { size: details.size, mtimeMs: details.mtimeMs };
          stableObservations = previous
            && previous.size === current.size
            && previous.mtimeMs === current.mtimeMs
            ? stableObservations + 1
            : 1;
          previous = current;
          if (stableObservations >= this.stablePolls) return { ...current, deadline };
        } else {
          previous = undefined;
          stableObservations = 0;
        }
      } catch {
        // The export may still be rendering or writing its output.
        previous = undefined;
        stableObservations = 0;
      }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    throw new Error(`FINAL_CUT_EXPORT_COMPLETION_TIMEOUT: Final Cut did not produce a non-empty file at ${outputPath}`);
  }

  private async probeUntilReady(outputPath: string, deadline: number): Promise<FinalCutVideoProbeResult> {
    while (true) {
      try {
        return await this.probe(outputPath);
      } catch (error) {
        if (this.now() >= deadline) {
          throw new Error(`FINAL_CUT_EXPORT_METADATA_FAILED: could not inspect ${outputPath} (${String(error)})`);
        }
        await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
      }
    }
  }

  private async withNativeUi<T>(operation: () => Promise<T>): Promise<T> {
    if (this.nativeOperationLease) this.nativeOperationLease.acquire();
    else this.suspendLiveConnection?.();
    try {
      return await operation();
    } finally {
      if (this.nativeOperationLease) this.nativeOperationLease.release();
      else this.resumeLiveConnection?.();
    }
  }
}

async function assertOutputDirectory(outputPath: string): Promise<void> {
  try {
    const parent = await stat(dirname(outputPath));
    if (!parent.isDirectory()) throw new Error("parent path is not a directory");
    await access(dirname(outputPath), constants.W_OK);
  } catch (error) {
    throw new Error(`FINAL_CUT_EXPORT_PATH_UNAVAILABLE: output directory is not writable (${String(error)})`);
  }
}

async function assertOutputCanBeReplaced(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    const details = await stat(outputPath);
    if (!details.isFile()) {
      throw new Error(`FINAL_CUT_EXPORT_OUTPUT_EXISTS: output path is not a file: ${outputPath}`);
    }
    if (!overwrite) {
      throw new Error(`FINAL_CUT_EXPORT_OUTPUT_EXISTS: refusing to replace existing output ${outputPath}; set overwrite=true to confirm`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (error instanceof Error && error.message.startsWith("FINAL_CUT_EXPORT_OUTPUT_EXISTS:")) throw error;
    throw new Error(`FINAL_CUT_EXPORT_PATH_UNAVAILABLE: could not prepare output path (${String(error)})`);
  }
}

function createStagingPath(outputPath: string): string {
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  return join(dirname(outputPath), `.${stem}.framekit-${randomUUID()}${extension}`);
}

async function commitOutput(stagingPath: string, outputPath: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    try {
      await stat(outputPath);
      throw new Error(`FINAL_CUT_EXPORT_OUTPUT_EXISTS: output appeared while export was running ${outputPath}`);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
  }
  try {
    await rename(stagingPath, outputPath);
  } catch (error) {
    throw new Error(`FINAL_CUT_EXPORT_COMMIT_FAILED: could not replace ${outputPath} (${String(error)})`);
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateExpectation(expectation: FinalCutVideoExportExpectation | undefined): void {
  if (!expectation) return;
  for (const [name, value] of Object.entries(expectation)) {
    if (name.endsWith("ToleranceSeconds") || name === "frameRateTolerance") continue;
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`INVALID_EXPORT: expected ${name} must be a positive finite number`);
    }
  }
  if (expectation.durationToleranceSeconds !== undefined
    && (!Number.isFinite(expectation.durationToleranceSeconds) || expectation.durationToleranceSeconds < 0)) {
    throw new Error("INVALID_EXPORT: durationToleranceSeconds must be a non-negative finite number");
  }
  if (expectation.frameRateTolerance !== undefined
    && (!Number.isFinite(expectation.frameRateTolerance) || expectation.frameRateTolerance < 0)) {
    throw new Error("INVALID_EXPORT: frameRateTolerance must be a non-negative finite number");
  }
}

function verifyMetadata(metadata: FinalCutVideoMetadata, expectation?: FinalCutVideoExportExpectation): void {
  if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    throw new Error("FINAL_CUT_EXPORT_VERIFICATION_FAILED: output duration is missing or invalid");
  }
  if (!Number.isInteger(metadata.width) || metadata.width <= 0 || !Number.isInteger(metadata.height) || metadata.height <= 0) {
    throw new Error("FINAL_CUT_EXPORT_VERIFICATION_FAILED: output resolution is missing or invalid");
  }
  if (!Number.isFinite(metadata.frameRate) || metadata.frameRate <= 0) {
    throw new Error("FINAL_CUT_EXPORT_VERIFICATION_FAILED: output frame rate is missing or invalid");
  }
  if (typeof metadata.hasAudio !== "boolean") {
    throw new Error("FINAL_CUT_EXPORT_VERIFICATION_FAILED: output audio presence is missing or invalid");
  }
  if (!expectation) return;
  if (expectation.durationSeconds !== undefined
    && Math.abs(metadata.durationSeconds - expectation.durationSeconds) > (expectation.durationToleranceSeconds ?? 0.05)) {
    throw new Error(`FINAL_CUT_EXPORT_VERIFICATION_FAILED: expected duration ${expectation.durationSeconds}s, observed ${metadata.durationSeconds}s`);
  }
  if (expectation.width !== undefined && metadata.width !== expectation.width) {
    throw new Error(`FINAL_CUT_EXPORT_VERIFICATION_FAILED: expected width ${expectation.width}, observed ${metadata.width}`);
  }
  if (expectation.height !== undefined && metadata.height !== expectation.height) {
    throw new Error(`FINAL_CUT_EXPORT_VERIFICATION_FAILED: expected height ${expectation.height}, observed ${metadata.height}`);
  }
  if (expectation.frameRate !== undefined
    && Math.abs(metadata.frameRate - expectation.frameRate) > (expectation.frameRateTolerance ?? 0.01)) {
    throw new Error(`FINAL_CUT_EXPORT_VERIFICATION_FAILED: expected frame rate ${expectation.frameRate}, observed ${metadata.frameRate}`);
  }
  if (expectation.hasAudio !== undefined && metadata.hasAudio !== expectation.hasAudio) {
    throw new Error(`FINAL_CUT_EXPORT_VERIFICATION_FAILED: expected audio presence ${expectation.hasAudio}, observed ${metadata.hasAudio}`);
  }
}

async function probeWithFfprobe(outputPath: string): Promise<FinalCutVideoProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,codec_name",
      "-of", "json",
      outputPath,
    ], { maxBuffer: 1_000_000 }));
  } catch (error) {
    throw new Error(`ffprobe failed: ${String(error)}`);
  }
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("ffprobe returned no video stream");
  const durationSeconds = Number(parsed.format?.duration);
  const width = Number(video.width);
  const height = Number(video.height);
  const frameRate = parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate);
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(frameRate)) {
    throw new Error("ffprobe returned incomplete video metadata");
  }
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds,
    width,
    height,
    frameRate,
    hasAudio: Boolean(audio),
    ...(typeof video.codec_name === "string" ? { videoCodec: video.codec_name } : {}),
    ...(typeof audio?.codec_name === "string" ? { audioCodec: audio.codec_name } : {}),
  };
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return Number(value);
  return numerator / denominator;
}

async function runAppleScript(script: string): Promise<string> {
  try {
    const result = await execFile("osascript", ["-e", script], { maxBuffer: 1_000_000 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
      throw new Error(`FINAL_CUT_EXPORT_PERMISSION_REQUIRED: ${detail}`);
    }
    throw new Error(`FINAL_CUT_EXPORT_AUTOMATION_FAILED: ${detail}`);
  }
}

function exportScript(outputPath: string, menuItem: string): string {
  return `
tell application "Final Cut Pro" to activate
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    set shareMenu to menu 1 of menu item "Share" of menu "File" of menu bar 1
    set matchingItems to every menu item of shareMenu whose name starts with "${menuItem}"
    if (count of matchingItems) is 0 then error "FINAL_CUT_EXPORT_PRESET_UNAVAILABLE: ${menuItem}"
    click item 1 of matchingItems
    delay 1
    try
      click button "Next" of front window
      delay 0.5
    end try
    keystroke "g" using {command down}
    delay 0.2
    set value of first text field of front window to ${appleScriptString(outputPath)}
    key code 36
    delay 0.5
    key code 36
  end tell
end tell`;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
}
