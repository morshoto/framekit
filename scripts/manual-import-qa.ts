import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Artifact measurements cannot establish how a movie was produced or imported. */
export interface ExportMeasurements {
  durationSeconds: number;
  samples: Array<{ timeSeconds: number; rgb: [number, number, number] }>;
  toneAmplitudes: number[];
}

export function evaluateExportMeasurements(observed: ExportMeasurements) {
  const samples = [0.5, 1.5, 2.5];
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 3) <= 0.05;
  const video = observed.samples.length === 3 && observed.samples.every((sample, index) => {
    const [r, g, b] = sample.rgb;
    const components = [r, g, b];
    const dominant = components[index]!;
    return Math.abs(sample.timeSeconds - samples[index]!) < 0.001
      && components.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
      && dominant > 140 && components.every((value, channel) => channel === index || dominant - value > 100);
  });
  const audio = observed.toneAmplitudes.length === 3 && observed.toneAmplitudes.every((value) => Number.isFinite(value) && value >= 0.002 && value <= 0.2);
  return {
    status: duration && video && audio ? "PASS" as const : "FAIL" as const,
    checks: { duration, video, audio },
    nativeImport: "UNVERIFIED" as const,
    titleEditability: "UNVERIFIED" as const,
    finalCutProvenance: "UNVERIFIED" as const,
  };
}


/** Decode independent output measurements; this never establishes native provenance. */
export async function measureExport(path: string): Promise<ExportMeasurements> {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const probe = JSON.parse((await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path])).stdout) as {
    format?: { duration?: string }; streams?: Array<{ codec_type?: string }>;
  };
  if (!probe.streams?.some((stream) => stream.codec_type === "video")) throw new Error("EXPORT_INVALID: video stream missing");
  const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
  const samples: ExportMeasurements["samples"] = [];
  const toneAmplitudes: number[] = [];
  for (const timeSeconds of [0.5, 1.5, 2.5]) {
    const pixels = await runBytes(ffmpeg, ["-v", "error", "-ss", String(timeSeconds), "-i", path,
      "-vf", "crop=2:2:2:2,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
    if (pixels.length !== 12) throw new Error(`EXPORT_INVALID: missing frame at ${timeSeconds}s`);
    samples.push({ timeSeconds, rgb: [pixels[0]!, pixels[1]!, pixels[2]!] });
    if (!hasAudio) { toneAmplitudes.push(0); continue; }
    const audio = await runBytes(ffmpeg, ["-v", "error", "-ss", String(timeSeconds - 0.125), "-i", path,
      "-t", "0.25", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
    const count = Math.floor(audio.length / 2);
    if (count < 1900) { toneAmplitudes.push(0); continue; }
    let sine = 0;
    let cosine = 0;
    for (let i = 0; i < count; i++) {
      const value = audio.readInt16LE(i * 2) / 32768;
      const phase = 2 * Math.PI * 880 * i / 8000;
      sine += value * Math.sin(phase);
      cosine += value * Math.cos(phase);
    }
    toneAmplitudes.push(2 * Math.hypot(sine, cosine) / count);
  }
  return { durationSeconds: Number(probe.format?.duration), samples, toneAmplitudes };
}

function runBytes(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
