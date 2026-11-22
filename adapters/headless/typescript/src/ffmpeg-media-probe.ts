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
      "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,time_base,start_pts,duration_ts,color_primaries,color_transfer,color_space,color_range",
      "-show_entries", "format=duration,start_time,format_name",
      "-of", "json",
      sourcePath,
    ], { env: this.environment, maxBuffer: 2 * 1024 * 1024 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("DEPENDENCY_MISSING: ffprobe is required; install FFmpeg and ensure ffprobe is on PATH", { cause: error });
      throw new Error(`MEDIA_PROBE_FAILED: could not inspect media ${sourcePath}; check that it is a complete supported file`, { cause: error });
    });
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number; time_base?: string; start_pts?: number; duration_ts?: number; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string }>;
      format?: { duration?: string; start_time?: string; format_name?: string };
    };
    const duration = decimalToRational(Number(parsed.format?.duration));
    if (!parsed.streams || !duration) throw new Error("HEADLESS_MEDIA_INVALID: ffprobe returned incomplete metadata");
    const streams: TimelineIrMediaStream[] = parsed.streams.flatMap((stream) => {
      if (stream.codec_type !== "video" && stream.codec_type !== "audio") return [];
      const color = stream.codec_type === "video" ? Object.fromEntries(
        [["primaries", stream.color_primaries], ["transfer", stream.color_transfer], ["matrix", stream.color_space], ["range", stream.color_range]]
          .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "unknown" && entry[1] !== "unspecified" && entry[1].length > 0),
      ) : {};
      // A single WAV stream starts at zero even when ffprobe omits start_pts
      // and format.start_time. Its duration_ts still supplies sample bounds.
      const wavStart = stream.codec_type === "audio" && parsed.format?.format_name === "wav"
        && parsed.streams!.length === 1 && stream.start_pts === undefined && parsed.format.start_time === undefined;
      const bounds = streamBounds(wavStart ? { ...stream, start_pts: 0 } : stream,
        wavStart ? "0" : parsed.format?.start_time);
      return [{
        kind: stream.codec_type,
        ...(stream.codec_name ? { codec: stream.codec_name } : {}),
        ...(stream.width !== undefined ? { width: stream.width } : {}),
        ...(stream.height !== undefined ? { height: stream.height } : {}),
        ...(stream.r_frame_rate ? { frameRate: parseRate(stream.r_frame_rate) } : {}),
        ...(Object.keys(color).length > 0 ? { color } : {}),
        ...(bounds ? { sourceRange: bounds } : {}),
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

function streamBounds(stream: { time_base?: string; start_pts?: number; duration_ts?: number }, formatStart?: string): { start: RationalTime; duration: RationalTime } | undefined {
  if (!stream.time_base || !/^\d+\/\d+$/.test(stream.time_base) || !Number.isSafeInteger(stream.start_pts) || !Number.isSafeInteger(stream.duration_ts) || stream.duration_ts! <= 0 || !formatStart || !/^-?\d+(?:\.\d+)?$/.test(formatStart)) return undefined;
  const [baseValue, baseScale] = stream.time_base.split("/").map(BigInt);
  if (baseValue <= 0n || baseScale <= 0n) return undefined;
  const [whole, fraction = ""] = formatStart.replace("-", "").split(".");
  const scale = 10n ** BigInt(fraction.length);
  const origin = (formatStart.startsWith("-") ? -1n : 1n) * (BigInt(whole!) * scale + BigInt(fraction || "0"));
  let startValue = BigInt(stream.start_pts!) * baseValue * scale - origin * baseScale;
  const startScale = baseScale * scale;
  // ffprobe formats the container origin at microsecond precision. Treat an
  // offset within half a microsecond as zero, in either rounding direction.
  const magnitude = startValue < 0n ? -startValue : startValue;
  if (magnitude * 2_000_000n <= startScale) startValue = 0n;
  if (startValue < 0n) return undefined;
  const startDivisor = gcd(startValue < 0n ? -startValue : startValue, startScale);
  const durationValue = BigInt(stream.duration_ts!) * baseValue;
  const durationDivisor = gcd(durationValue, baseScale);
  return { start: { value: String(startValue / startDivisor), timescale: String(startScale / startDivisor) }, duration: { value: String(durationValue / durationDivisor), timescale: String(baseScale / durationDivisor) } };
}
