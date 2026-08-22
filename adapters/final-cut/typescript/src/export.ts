import { execFile as execFileCallback } from "node:child_process";
import { access, constants, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

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
  probe?: (outputPath: string) => Promise<FinalCutVideoProbeResult>;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  suspendLiveConnection?: () => void;
  resumeLiveConnection?: () => void;
}

/** Exports the active Final Cut timeline and verifies the resulting media file. */
export class FinalCutVideoExporter {
  private readonly enabled: boolean;
  private readonly executor: (script: string) => Promise<string>;
  private readonly probe: (outputPath: string) => Promise<FinalCutVideoProbeResult>;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly suspendLiveConnection?: () => void;
  private readonly resumeLiveConnection?: () => void;

  public constructor(options: FinalCutVideoExporterOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.executor = options.executor ?? runAppleScript;
    this.probe = options.probe ?? probeWithFfprobe;
    this.waitMs = options.waitMs ?? 120_000;
    this.pollMs = options.pollMs ?? 250;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.suspendLiveConnection = options.suspendLiveConnection;
    this.resumeLiveConnection = options.resumeLiveConnection;
  }

  public async exportVideo(request: FinalCutVideoExportRequest): Promise<FinalCutVideoExportResult> {
    if (!this.enabled) {
      throw new Error("CAPABILITY_UNAVAILABLE: Final Cut video export is disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    }
    const outputPath = resolve(request.outputPath.trim());
    if (!request.outputPath.trim()) throw new Error("INVALID_EXPORT: outputPath is required");
    const preset = FINAL_CUT_EXPORT_PRESETS[request.preset];
    if (!preset) throw new Error(`INVALID_EXPORT_PRESET: unsupported Final Cut export preset ${String(request.preset)}`);
    await assertOutputDirectory(outputPath);
    await prepareOutput(outputPath, request.overwrite ?? false);
    validateExpectation(request.expected);

    return this.withNativeUi(async () => {
      await this.executor(exportScript(outputPath, preset.menuItem));
      const output = await this.waitForOutput(outputPath);
      let probed: FinalCutVideoProbeResult;
      try {
        probed = await this.probe(outputPath);
      } catch (error) {
        throw new Error(`FINAL_CUT_EXPORT_METADATA_FAILED: could not inspect ${outputPath} (${String(error)})`);
      }
      const metadata: FinalCutVideoMetadata = {
        outputPath,
        sizeBytes: output.size,
        ...probed,
      };
      verifyMetadata(metadata, request.expected);
      return {
        outputPath,
        preset: request.preset,
        completed: true,
        verified: true,
        metadata,
      };
    });
  }

  private async waitForOutput(outputPath: string): Promise<{ size: number }> {
    const deadline = this.now() + this.waitMs;
    while (true) {
      try {
        const details = await stat(outputPath);
        if (details.isFile() && details.size > 0) return { size: details.size };
      } catch {
        // The export may still be rendering or writing its output.
      }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    throw new Error(`FINAL_CUT_EXPORT_COMPLETION_TIMEOUT: Final Cut did not produce a non-empty file at ${outputPath}`);
  }

  private async withNativeUi<T>(operation: () => Promise<T>): Promise<T> {
    this.suspendLiveConnection?.();
    try {
      return await operation();
    } finally {
      this.resumeLiveConnection?.();
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

async function prepareOutput(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    const details = await stat(outputPath);
    if (!details.isFile()) {
      throw new Error(`FINAL_CUT_EXPORT_OUTPUT_EXISTS: output path is not a file: ${outputPath}`);
    }
    if (!overwrite) {
      throw new Error(`FINAL_CUT_EXPORT_OUTPUT_EXISTS: refusing to replace existing output ${outputPath}; set overwrite=true to confirm`);
    }
    await unlink(outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (error instanceof Error && error.message.startsWith("FINAL_CUT_EXPORT_OUTPUT_EXISTS:")) throw error;
    throw new Error(`FINAL_CUT_EXPORT_PATH_UNAVAILABLE: could not prepare output path (${String(error)})`);
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
    click menu item "${menuItem}" of menu "Share" of menu "File" of menu bar 1
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
