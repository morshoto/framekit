import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  FramekitRenderArtifactMetadata,
  FramekitRenderArtifactStream,
  FramekitRenderPlan,
  FramekitRenderProviderResult,
  FramekitRenderVerificationCheck,
  FramekitRenderVerificationResult,
  FramekitRenderArtifactVerifier,
  RationalTime,
} from "@framekit/runtime";

const execFileAsync = promisify(execFile);

export interface FfmpegRenderVerifierOptions {
  ffprobePath?: string;
  durationToleranceSeconds?: number;
  env?: NodeJS.ProcessEnv;
}

/** Independently verifies the committed output; it does not trust provider metadata. */
export class FfmpegRenderVerifier implements FramekitRenderArtifactVerifier {
  private readonly ffprobePath: string;
  private readonly durationToleranceSeconds?: number;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(options: FfmpegRenderVerifierOptions = {}) {
    this.ffprobePath = options.ffprobePath ?? process.env.FFPROBE_BIN ?? "ffprobe";
    this.durationToleranceSeconds = options.durationToleranceSeconds;
    this.environment = { ...process.env, ...options.env };
  }

  public async verify(plan: FramekitRenderPlan, result: FramekitRenderProviderResult): Promise<FramekitRenderVerificationResult> {
    const outputPath = resolve(result.output.path);
    const checks: FramekitRenderVerificationCheck[] = [];
    let details;
    try {
      details = await lstat(outputPath);
    } catch {
      return failed([], `render output does not exist: ${outputPath}`, "RENDER_OUTPUT_MISSING");
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      return failed(checks, "render output is not a regular file", "RENDER_OUTPUT_INVALID");
    }

    const fileStats = await stat(outputPath);
    const fileDigest = await digestFile(outputPath);
    const fileIdentity = { device: fileStats.dev, inode: fileStats.ino, size: fileStats.size };
    checks.push({ name: "output-exists", passed: true, detail: "render output is a regular file", observed: { path: outputPath } });
    checks.push({ name: "output-digest", passed: /^[a-f0-9]{64}$/.test(fileDigest), detail: "render output has a SHA-256 digest", observed: fileDigest });

    let probe: ProbeResult;
    try {
      probe = await this.probe(outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof Error && /spawn ffprobe ENOENT/.test(error.message))) {
        return unavailable("ffprobe is not configured", "RENDER_VERIFIER_UNAVAILABLE");
      }
      return failed(checks, error instanceof Error ? error.message : String(error), "RENDER_OUTPUT_UNPLAYABLE");
    }
    let finalDetails;
    try {
      finalDetails = await lstat(outputPath);
    } catch {
      return failed(checks, `render output changed during verification: ${outputPath}`, "RENDER_OUTPUT_CHANGED");
    }
    if (!finalDetails.isFile() || finalDetails.isSymbolicLink()) {
      return failed(checks, "render output changed into a non-regular file during verification", "RENDER_OUTPUT_CHANGED");
    }
    const finalDigest = await digestFile(outputPath);
    if (finalDetails.dev !== fileIdentity.device || finalDetails.ino !== fileIdentity.inode || finalDetails.size !== fileIdentity.size || finalDigest !== fileDigest) {
      return failed(checks, "render output bytes or file identity changed during verification", "RENDER_OUTPUT_CHANGED");
    }
    checks.push({ name: "output-stability", passed: true, detail: "the verified metadata and digest refer to one unchanged output file" });
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    if (!video || video.width === undefined || video.height === undefined || !video.r_frame_rate) {
      return failed(checks, "render output has no complete video stream", "RENDER_OUTPUT_UNPLAYABLE");
    }
    const expectedFrameRate = parseRational(plan.parameters.frameRate);
    const expectedAudio = expectedAudioStream(plan);
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    const observedFrameRate = parseFfmpegRate(video.r_frame_rate);
    const expectedDuration = rationalSeconds(plan.timeline.sequence.durationTime);
    const tolerance = this.durationToleranceSeconds ?? Math.max(0.05, rationalSeconds(plan.timeline.sequence.frameDuration) * 1.5);
    const durationPassed = Number.isFinite(probe.format.duration)
      && Math.abs(probe.format.duration - expectedDuration) <= tolerance;
    const frameRatePassed = observedFrameRate !== undefined && sameRational(observedFrameRate, expectedFrameRate);
    const formatPassed = probe.format.format_name.split(",").some((format) => format === plan.parameters.format);
    checks.push({ name: "playable", passed: true, detail: "ffprobe read the output streams and duration" });
    checks.push({ name: "format", passed: formatPassed, detail: "output container matches the explicit request", expected: plan.parameters.format, observed: probe.format.format_name });
    checks.push({ name: "dimensions", passed: video.width === plan.parameters.width && video.height === plan.parameters.height, detail: "output dimensions match the explicit request", expected: { width: plan.parameters.width, height: plan.parameters.height }, observed: { width: video.width, height: video.height } });
    checks.push({ name: "frame-rate", passed: frameRatePassed, detail: "output rational frame rate matches the explicit request", expected: expectedFrameRate, observed: observedFrameRate });
    const audioPassed = expectedAudio === undefined || (
      audio !== undefined
      && (expectedAudio.sampleRate === undefined || Number(audio.sample_rate) === expectedAudio.sampleRate)
      && (expectedAudio.channels === undefined || audio.channels === expectedAudio.channels)
    );
    checks.push({ name: "audio-stream", passed: audioPassed, detail: "canonical audio stream presence and metadata are preserved", expected: expectedAudio ?? { kind: "none" }, observed: audio ?? { kind: "none" } });
    checks.push({ name: "duration", passed: durationPassed, detail: `output duration is within ${tolerance} seconds of the canonical sequence`, expected: expectedDuration, observed: probe.format.duration });
    const artifact: FramekitRenderArtifactMetadata = {
      path: result.output.path,
      format: probe.format.format_name,
      sizeBytes: fileStats.size,
      fileDigest,
      durationSeconds: probe.format.duration,
      width: video.width,
      height: video.height,
      frameRate: observedFrameRate ?? expectedFrameRate,
      streams: probe.streams.map(toArtifactStream),
    };
    const passed = checks.every((check) => check.passed);
    return { status: passed ? "passed" : "failed", checks, artifact };
  }

  private async probe(path: string): Promise<ProbeResult> {
    const result = await execFileAsync(this.ffprobePath, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
      "-show_entries", "format=format_name,duration",
      "-of", "json",
      path,
    ], { env: this.environment, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout) as Partial<ProbeResult>;
    if (!Array.isArray(parsed.streams) || !parsed.format || typeof parsed.format.duration !== "string" || !Number.isFinite(Number(parsed.format.duration))) {
      throw new Error("ffprobe returned incomplete output metadata");
    }
    return {
      streams: parsed.streams as ProbeStream[],
      format: { format_name: String(parsed.format.format_name ?? ""), duration: Number(parsed.format.duration) },
    };
  }
}

interface ProbeStream {
  codec_type: "video" | "audio";
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface ProbeResult {
  streams: ProbeStream[];
  format: { format_name: string; duration: number };
}

function expectedAudioStream(plan: FramekitRenderPlan): { sampleRate?: number; channels?: number } | undefined {
  const resources = new Map(plan.timeline.resources.map((resource) => [resource.id, resource]));
  for (const occurrence of plan.timeline.sequence.occurrences) {
    const resource = occurrence.mediaId ? resources.get(occurrence.mediaId) : undefined;
    const stream = resource?.metadata?.streams.find((candidate) => candidate.kind === "audio");
    if (stream) return { sampleRate: stream.sampleRate, channels: stream.channels };
  }
  return undefined;
}

function toArtifactStream(stream: ProbeStream): FramekitRenderArtifactStream {
  return {
    kind: stream.codec_type,
    ...(stream.codec_name ? { codec: stream.codec_name } : {}),
    ...(stream.width !== undefined ? { width: stream.width } : {}),
    ...(stream.height !== undefined ? { height: stream.height } : {}),
    ...(stream.r_frame_rate ? { frameRate: parseFfmpegRate(stream.r_frame_rate) } : {}),
    ...(stream.sample_rate ? { sampleRate: Number(stream.sample_rate) } : {}),
    ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
  };
}

function parseFfmpegRate(value: string | undefined): RationalTime | undefined {
  if (!value || !/^\d+\/\d+$/.test(value)) return undefined;
  const [numerator, denominator] = value.split("/").map(BigInt);
  if (denominator <= 0n) return undefined;
  const divisor = gcd(numerator, denominator);
  return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
}

function parseRational(value: RationalTime): RationalTime {
  const numerator = BigInt(value.value);
  const denominator = BigInt(value.timescale);
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
}

function sameRational(left: RationalTime, right: RationalTime): boolean {
  return left.value === right.value && left.timescale === right.timescale;
}

function rationalSeconds(value: RationalTime): number {
  return Number(BigInt(value.value)) / Number(BigInt(value.timescale));
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return digest.digest("hex");
}

function failed(checks: FramekitRenderVerificationCheck[], message: string, code: string): FramekitRenderVerificationResult {
  return { status: "failed", checks: [...checks, { name: code.toLowerCase(), passed: false, detail: message }], error: { code, message } };
}

function unavailable(message: string, code: string): FramekitRenderVerificationResult {
  return { status: "unavailable", checks: [{ name: code.toLowerCase(), passed: false, detail: message }], error: { code, message } };
}
