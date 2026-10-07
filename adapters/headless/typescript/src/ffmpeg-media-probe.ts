import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import type { LocalMediaMetadataProbe, TimelineIrMediaMetadata, TimelineIrMediaStream, RationalTime } from "@framekit/runtime";

const execFileAsync = promisify(execFile);

export interface FfmpegMediaMetadataProbeOptions {
  ffprobePath?: string;
  env?: NodeJS.ProcessEnv;
}

export class FfmpegMediaMetadataProbe implements LocalMediaMetadataProbe {
  private readonly ffprobePath: string;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(options: FfmpegMediaMetadataProbeOptions = {}) {
    this.ffprobePath = options.ffprobePath ?? process.env.FFPROBE_BIN ?? "ffprobe";
    this.environment = { ...process.env, ...options.env };
  }

  public async probe(sourcePath: string): Promise<TimelineIrMediaMetadata> {
    const details = await lstat(sourcePath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`HEADLESS_MEDIA_INVALID: source is not a regular file: ${sourcePath}`);
    const result = await execFileAsync(this.ffprobePath, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
      "-show_entries", "format=duration",
      "-of", "json",
      sourcePath,
    ], { env: this.environment, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
      format?: { duration?: string };
    };
    const duration = decimalToRational(Number(parsed.format?.duration));
    if (!parsed.streams || !duration) throw new Error("HEADLESS_MEDIA_INVALID: ffprobe returned incomplete metadata");
    const streams: TimelineIrMediaStream[] = parsed.streams.flatMap((stream) => {
      if (stream.codec_type !== "video" && stream.codec_type !== "audio") return [];
      return [{
        kind: stream.codec_type,
        ...(stream.codec_name ? { codec: stream.codec_name } : {}),
        ...(stream.width !== undefined ? { width: stream.width } : {}),
        ...(stream.height !== undefined ? { height: stream.height } : {}),
        ...(stream.r_frame_rate ? { frameRate: parseRate(stream.r_frame_rate) } : {}),
        ...(stream.sample_rate ? { sampleRate: Number(stream.sample_rate) } : {}),
        ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
      } satisfies TimelineIrMediaStream];
    });
    return { durationTime: duration, streams };
  }
}

function parseRate(value: string): RationalTime {
  const [numerator, denominator] = value.split("/").map(BigInt);
  const divisor = gcd(numerator, denominator);
  return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
}

function decimalToRational(value: number): RationalTime | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const scaled = Math.round(value * 1_000_000);
  const divisor = gcd(BigInt(scaled), 1_000_000n);
  return { value: String(BigInt(scaled) / divisor), timescale: String(1_000_000n / divisor) };
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}
