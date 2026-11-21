import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release as osRelease } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";

const run = promisify(execFile);
async function writeReceipt(directory: string, filename: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    await link(temporary, join(directory, filename)); // Atomic and create-only.
  } finally {
    await unlink(temporary);
  }
  return createHash("sha256").update(content).digest("hex");
}
/** Artifact measurements cannot establish how a movie was produced or imported. */
export interface ExportMeasurements {
  durationSeconds: number;
  frameCount: number;
  frameRate: string;
  boundarySamples: Array<{ frameNumber: number; rgb: [number, number, number] }>;
  samples: Array<{ timeSeconds: number; rgb: [number, number, number] }>;
  toneAmplitudes: number[];
}

/** Measurements for the fixed two-second, 30 fps finishing diagnostic. */
export interface DissolveExportMeasurements {
  durationSeconds: number;
  frameCount: number;
  frameRate: string;
  frames: Array<{ frameNumber: number; rgb: [number, number, number] }>;
  audio: Array<{ timeSeconds: number; outgoing: number; incoming: number; music: number }>;
}

export interface TitleBounds { x: number; y: number; width: number; height: number }

/** Locate the fixture's white basic title in its fixed 720p center region. */
export async function measureFixtureTitleBounds(path: string, frameNumber: number): Promise<TitleBounds> {
  if (!Number.isSafeInteger(frameNumber) || frameNumber < 0) throw new Error("TITLE_FRAME_INVALID: expected a nonnegative frame number");
  const probe = JSON.parse((await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path])).stdout) as { streams?: Array<{ width?: number; height?: number }> };
  if (probe.streams?.[0]?.width !== 1280 || probe.streams[0]?.height !== 720) throw new Error("TITLE_FORMAT_UNSUPPORTED: fixture title measurement requires 1280x720 video");
  const width = 320, height = 200, left = 480, top = 250;
  const pixels = await runBytes(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", path, "-map", "0:v:0", "-vf", `select=eq(n\\,${frameNumber}),crop=${width}:${height}:${left}:${top},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
  if (pixels.length !== width * height * 3) throw new Error("TITLE_FRAME_INVALID: requested frame is unavailable");
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    if (pixels[offset]! > 210 && pixels[offset + 1]! > 210 && pixels[offset + 2]! > 210) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error("TITLE_NOT_DETECTED: no white fixture title pixels found");
  if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) throw new Error("TITLE_BOUNDS_UNSUPPORTED: white pixels touch the measurement region boundary");
  return { x: left + minX, y: top + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Compare only the sampled synthetic fixture; native provenance and exact boundaries require separate proof. */
export function compareDissolveParity(reference: DissolveExportMeasurements, candidate: DissolveExportMeasurements, referenceTitle: TitleBounds, candidateTitle: TitleBounds) {
  const signals = evaluateDissolveExportMeasurements(reference).status === "PASS"
    && evaluateDissolveExportMeasurements(candidate).status === "PASS";
  const colors = signals && reference.frames.every((frame, index) => frame.rgb.every((value, channel) =>
    Math.abs(value - candidate.frames[index]!.rgb[channel]!) <= 20));
  const audio = signals && reference.audio.every((window, index) => {
    const actual = candidate.audio[index]!;
    return (["outgoing", "incoming", "music"] as const).every((name) => {
      const minimum = name === "music" ? 0.002 : 0.01;
      if (window[name] < minimum) return true; // Near-silent leakage is checked by the independent signal evaluator.
      return actual[name] > 0 && Math.abs(20 * Math.log10(actual[name] / window[name])) <= 1;
    });
  });
  const validBounds = (box: TitleBounds) => [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1280 && box.y + box.height <= 720;
  const titles = validBounds(referenceTitle) && validBounds(candidateTitle);
  const titleSize = titles && Math.abs(candidateTitle.width / referenceTitle.width - 1) <= 0.1
    && Math.abs(candidateTitle.height / referenceTitle.height - 1) <= 0.1;
  const titlePosition = titles
    && Math.abs(candidateTitle.x + candidateTitle.width / 2 - referenceTitle.x - referenceTitle.width / 2) <= 12.8
    && Math.abs(candidateTitle.y + candidateTitle.height / 2 - referenceTitle.y - referenceTitle.height / 2) <= 7.2;
  return {
    status: signals && colors && audio && titleSize && titlePosition ? "PASS" as const : "FAIL" as const,
    checks: { signals, colors, audio, titleSize, titlePosition },
    nativeImport: "UNVERIFIED" as const, finalCutProvenance: "UNVERIFIED" as const,
    titleEditability: "UNVERIFIED" as const, exactBoundaries: "UNVERIFIED" as const,
  };
}

/** Check only sampled signals; this does not establish native provenance or title editability. */
export function evaluateDissolveExportMeasurements(observed: DissolveExportMeasurements) {
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 2) <= 0.05
    && observed.frameCount === 60 && observed.frameRate === "30/1";
  const frameNumbers = [23, 25, 27, 29, 30];
  const framesValid = observed.frames.length === frameNumbers.length && observed.frames.every((frame, index) =>
    frame.frameNumber === frameNumbers[index] && frame.rgb.length === 3
    && frame.rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 255));
  let video = false;
  if (framesValid) {
    const [pre, early, middle, late, post] = observed.frames.map(({ rgb }) => rgb) as [[number, number, number], [number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    video = pre[0] > 140 && pre[0] - pre[2] > 100
      && early[0] > 100 && early[2] > 30 && middle[0] > 80 && middle[2] > 100
      && late[0] > 20 && late[2] > 140 && post[1] > 140 && post[2] > 140 && post[0] < 100
      && early[0] > middle[0] && middle[0] > late[0] && early[2] < middle[2] && middle[2] < late[2];
  }
  const times = [0.5, 0.825, 0.9, 0.975, 1.5];
  const windowsValid = observed.audio.length === times.length && observed.audio.every((window, index) =>
    Math.abs(window.timeSeconds - times[index]!) < 0.001
    && [window.outgoing, window.incoming, window.music].every((value) => Number.isFinite(value) && value >= 0 && value <= 0.2));
  let audio = false;
  if (windowsValid) {
    const [pre, early, middle, late, post] = observed.audio;
    const outgoingBase = pre!.outgoing;
    const incomingBase = post!.incoming;
    const ratio = (value: number, base: number, min: number, max: number) => base >= 0.01 && value / base >= min && value / base <= max;
    audio = ratio(pre!.incoming, incomingBase, 0, 0.1) && ratio(post!.outgoing, outgoingBase, 0, 0.1)
      && ratio(early!.outgoing, outgoingBase, 0.9, 1.1) && ratio(early!.incoming, incomingBase, 0, 0.1)
      && ratio(middle!.outgoing, outgoingBase, 0.3, 0.7) && ratio(middle!.incoming, incomingBase, 0.3, 0.7)
      && ratio(late!.outgoing, outgoingBase, 0, 0.1) && ratio(late!.incoming, incomingBase, 0.9, 1.1)
      && observed.audio.every((window) => ratio(window.music, outgoingBase, 0.17, 0.34));
  }
  return { status: duration && video && audio ? "PASS" as const : "FAIL" as const, checks: { duration, video, audio }, nativeImport: "UNVERIFIED" as const, titleEditability: "UNVERIFIED" as const, finalCutProvenance: "UNVERIFIED" as const };
}

/** Decode the fixed synthetic dissolve case; the source of the file remains unverified. */
export async function measureDissolveExport(path: string, stereoDownmix = false): Promise<DissolveExportMeasurements> {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const probe = JSON.parse((await run(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,nb_read_frames", "-of", "json", path])).stdout) as {
    format?: { duration?: string }; streams?: Array<{ codec_type?: string; avg_frame_rate?: string; nb_read_frames?: string }>;
  };
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("EXPORT_INVALID: video stream missing");
  // Decode every cropped frame: a filter graph can reinitialize on a native
  // format change and reset the `select` filter's frame counter.
  const pixels = await runBytes(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-vf", "crop=2:2:2:2,format=rgb24", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
  if (pixels.length % 12 !== 0 || pixels.length / 12 !== Number(video.nb_read_frames)) throw new Error("EXPORT_INVALID: decoded frame count differs from probe");
  const frames: DissolveExportMeasurements["frames"] = [];
  for (const frameNumber of [23, 25, 27, 29, 30]) {
    const offset = frameNumber * 12;
    if (offset + 12 > pixels.length) throw new Error(`EXPORT_INVALID: missing frame ${frameNumber}`);
    frames.push({ frameNumber, rgb: [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!] });
  }
  const audio: DissolveExportMeasurements["audio"] = [];
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  for (const timeSeconds of [0.5, 0.825, 0.9, 0.975, 1.5]) {
    const pcm = hasAudio ? await runBytes(ffmpeg, ["-v", "error", "-ss", String(timeSeconds - 0.0125), "-i", path, "-t", "0.025", "-vn", ...(stereoDownmix ? ["-af", "pan=mono|c0=0.7071067811865476*c0+0.7071067811865476*c1"] : []), "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]) : Buffer.alloc(0);
    const count = Math.floor(pcm.length / 4);
    const amplitude = (frequency: number) => {
      if (count < 1200) return 0;
      let sine = 0, cosine = 0;
      for (let i = 0; i < count; i++) {
        const sample = pcm.readFloatLE(i * 4), phase = 2 * Math.PI * frequency * i / 48_000;
        sine += sample * Math.sin(phase); cosine += sample * Math.cos(phase);
      }
      return 2 * Math.hypot(sine, cosine) / count;
    };
    audio.push({ timeSeconds, outgoing: amplitude(440), incoming: amplitude(880), music: amplitude(1760) });
  }
  return { durationSeconds: Number(probe.format?.duration), frameCount: Number(video.nb_read_frames), frameRate: video.avg_frame_rate ?? "", frames, audio };
}

/** Compare two fixed-fixture videos; this does not authenticate their provenance. */
export async function compareDissolveVideos(referencePath: string, candidatePath: string, outputDirectory: string) {
  const reference = resolve(referencePath), candidate = resolve(candidatePath), destination = resolve(outputDirectory);
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const [referenceSha256, candidateSha256] = await Promise.all([sha(reference), sha(candidate)]);
  const probeAudio = async (path: string) => {
    const value = JSON.parse((await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate", "-of", "json", path])).stdout) as { streams?: Array<{ channels?: number; sample_rate?: string }> };
    return value.streams?.[0];
  };
  const [referenceAudio, candidateAudio] = await Promise.all([probeAudio(reference), probeAudio(candidate)]);
  if (referenceAudio?.channels !== 2 || referenceAudio.sample_rate !== "48000" || candidateAudio?.channels !== 1 || candidateAudio.sample_rate !== "48000") {
    throw new Error("AUDIO_FORMAT_UNSUPPORTED: reference must be 48 kHz stereo and candidate 48 kHz mono");
  }
  const [referenceMeasurements, candidateMeasurements, referenceTitle, candidateTitle] = await Promise.all([
    measureDissolveExport(reference, true), measureDissolveExport(candidate),
    measureFixtureTitleBounds(reference, 27), measureFixtureTitleBounds(candidate, 27),
  ]);
  if (await sha(reference) !== referenceSha256 || await sha(candidate) !== candidateSha256) throw new Error("EXPORT_CHANGED: video changed during comparison");
  const report = { schemaVersion: 1, scenario: "synthetic-six-frame-dissolve-720p", referenceSha256, candidateSha256,
    downmix: "mono = 0.7071067811865476 * left + 0.7071067811865476 * right; 48000 Hz",
    referenceMeasurements, candidateMeasurements, referenceTitle, candidateTitle,
    comparison: compareDissolveParity(referenceMeasurements, candidateMeasurements, referenceTitle, candidateTitle),
    limitation: "Sampled parity does not establish approved source identity, exact boundaries, title text or editability, Final Cut import, or export provenance.",
  };
  await mkdir(destination);
  await writeFile(join(destination, "parity.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

/** Inspect the fixed synthetic case without claiming an import or production provenance. */
export async function inspectDissolveExport(exportPath: string, outputDirectory: string) {
  const movie = resolve(exportPath), destination = resolve(outputDirectory);
  const sha = async () => createHash("sha256").update(await readFile(movie)).digest("hex");
  const exportSha256 = await sha();
  await mkdir(destination);
  const observed = await measureDissolveExport(movie);
  if (await sha() !== exportSha256) throw new Error("EXPORT_CHANGED: video changed during inspection");
  const report = {
    schemaVersion: 1, scenario: "synthetic-six-frame-dissolve", exportSha256, observed,
    measurements: evaluateDissolveExportMeasurements(observed), titleVisibility: "UNVERIFIED" as const,
    limitation: "Signal measurements do not establish approved inputs, a Final Cut import or export, visual color parity, or title editability.",
  };
  await writeFile(join(destination, "observation.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

export function evaluateExportMeasurements(observed: ExportMeasurements) {
  const samples = [0.5, 1.5, 2.5];
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 3) <= 0.05
    && observed.frameCount === 90 && observed.frameRate === "30/1";
  const isColor = (components: number[], index: number) => {
    const dominant = components[index]!;
    return components.length === 3 && components.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
      && dominant > 140 && components.every((value, channel) => channel === index || dominant - value > 100);
  };
  const expectedBoundaries = [{ frame: 29, color: 0 }, { frame: 30, color: 1 }, { frame: 59, color: 1 }, { frame: 60, color: 2 }];
  const boundaries = observed.boundarySamples.length === expectedBoundaries.length && observed.boundarySamples.every((sample, index) =>
    sample.frameNumber === expectedBoundaries[index]!.frame && isColor(sample.rgb, expectedBoundaries[index]!.color));
  const video = boundaries && observed.samples.length === 3 && observed.samples.every((sample, index) => {
    return Math.abs(sample.timeSeconds - samples[index]!) < 0.001 && isColor(sample.rgb, index);
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


/** Check the independently specified v2 color order and 15-frame black tail. */
export function evaluateRevisedExportMeasurements(observed: ExportMeasurements) {
  const color = (rgb: number[], channel: number) => rgb.length === 3 && rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)
    && (channel === -1 ? rgb.every((v) => v < 40) : rgb[channel]! > 140 && rgb.every((v, i) => i === channel || rgb[channel]! - v > 100));
  const samples = [[0.5, 2], [1.5, 0], [2.25, 1], [2.75, -1]];
  const boundaries = [[29, 2], [30, 0], [59, 0], [60, 1], [74, 1], [75, -1]];
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 3) <= 0.05 && observed.frameCount === 90 && observed.frameRate === "30/1";
  const video = observed.samples.length === samples.length && observed.samples.every((s, i) => Math.abs(s.timeSeconds - samples[i]![0]!) < 0.001 && color(s.rgb, samples[i]![1]!))
    && observed.boundarySamples.length === boundaries.length && observed.boundarySamples.every((s, i) => s.frameNumber === boundaries[i]![0] && color(s.rgb, boundaries[i]![1]!));
  const audio = observed.toneAmplitudes.length === 4 && observed.toneAmplitudes.every((v) => Number.isFinite(v) && v >= 0.002 && v <= 0.2);
  return { status: duration && video && audio ? "PASS" as const : "FAIL" as const, checks: { duration, video, audio }, nativeImport: "UNVERIFIED" as const, titleEditability: "UNVERIFIED" as const, finalCutProvenance: "UNVERIFIED" as const };
}

/** Decode independent output measurements; this never establishes native provenance. */
export async function measureExport(path: string, version: "original" | "revised" = "original"): Promise<ExportMeasurements> {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const probe = JSON.parse((await run(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,nb_read_frames", "-of", "json", path])).stdout) as {
    format?: { duration?: string }; streams?: Array<{ codec_type?: string; avg_frame_rate?: string; nb_read_frames?: string }>;
  };
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("EXPORT_INVALID: video stream missing");
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  const samples: ExportMeasurements["samples"] = [];
  const toneAmplitudes: number[] = [];
  for (const timeSeconds of version === "revised" ? [0.5, 1.5, 2.25, 2.75] : [0.5, 1.5, 2.5]) {
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
  const boundarySamples: ExportMeasurements["boundarySamples"] = [];
  for (const frameNumber of version === "revised" ? [29, 30, 59, 60, 74, 75] : [29, 30, 59, 60]) {
    const pixels = await runBytes(ffmpeg, ["-v", "error", "-i", path,
      "-vf", `select=eq(n\\,${frameNumber}),crop=2:2:2:2,format=rgb24`, "-fps_mode", "passthrough", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
    if (pixels.length !== 12) throw new Error(`EXPORT_INVALID: missing frame ${frameNumber}`);
    boundarySamples.push({ frameNumber, rgb: [pixels[0]!, pixels[1]!, pixels[2]!] });
  }
  return { durationSeconds: Number(probe.format?.duration), frameCount: Number(videoStream.nb_read_frames),
    frameRate: videoStream.avg_frame_rate ?? "", samples, boundarySamples, toneAmplitudes };
}

function runBytes(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}


/** Generate non-private inputs and the exact production-MCP FCPXML handoff. */
export async function prepareManualImportFixture(outputDirectory: string) {
  const destination = resolve(outputDirectory);
  await mkdir(destination); // Exclusive: never overwrite a pre-existing directory.
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const sources = [
    { filename: "red.mp4", color: "red" },
    { filename: "green.mp4", color: "lime" },
    { filename: "blue.mp4", color: "blue" },
  ];
  for (const source of sources) {
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=black:s=1280x720:r=30:d=1",
      "-f", "lavfi", "-i", `color=${source.color}:s=1280x720:r=30:d=2`,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", join(destination, source.filename)]);
  }
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i",
    "sine=frequency=880:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", join(destination, "music.wav")]);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER;
  Object.assign(env, { FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(destination, "absent.sock"),
    FRAMEKIT_FCPXML_PATH: join(destination, "absent.fcpxml"), FRAMEKIT_STATE_DIR: join(destination, "state") });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", join(repository, "apps/mcp-server/src/main.ts")], env, stderr: "pipe" });
  const client = new Client({ name: "framekit-manual-import-qa", version: "1.0.0" });
  const seconds = (value: number) => ({ value: String(value), timescale: "1" });
  const projectId = `qa-${randomUUID()}`;
  const sequenceId = `sequence-${randomUUID()}`;
  const artifactPath = join(destination, "edit.fcpxml");
  let result: any;
  const receipts: Record<string, string> = {};
  let media: Array<{ filename: string; id: string }> = [];
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as Array<{ type: string; text?: string }>;
      if (response.isError || content[0]?.type !== "text") throw new Error(`${name}: ${content[0]?.text ?? "invalid response"}`);
      return JSON.parse(content[0].text ?? "null");
    };
    const created = await call("headless.project.create", { timeline: {
      schemaVersion: 1, project: { id: projectId, name: "Disposable Framekit QA" },
      sequence: { id: sequenceId, name: "Manual import QA", durationTime: seconds(0), frameDuration: { value: "1", timescale: "30" },
        occurrences: [], storyElements: [], markers: [], captions: [], titles: [], transitions: [] },
      resources: [], revision: { id: "initial", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" },
    } });
    let revision = created.timeline.revision;
    for (const filename of [...sources.map((source) => source.filename), "music.wav"]) {
      const registered = await call("headless.media.register", { projectId, sourcePath: join(destination, filename), expectedRevision: revision });
      media.push({ filename, id: registered.resource.id });
      revision = registered.project.timeline.revision;
    }
    const edit = { schemaVersion: 1, clips: media.slice(0, 3).map((source, index) => ({
      id: `clip-${index + 1}`, mediaId: source.id, sourceStartTime: seconds(1), durationTime: seconds(1),
    })), title: { id: "title", text: "FRAMEKIT QA", startTime: seconds(0), durationTime: seconds(1) },
    music: { id: "music", mediaId: media[3]!.id, sourceStartTime: seconds(0), startTime: seconds(0), durationTime: seconds(3), gainDb: -12 } };
    const request = { projectId, sequenceId, expectedRevision: revision, edit };
    receipts["input-edit.json"] = await writeReceipt(destination, "input-edit.json", { schemaVersion: 1, request });
    const preview = await call("headless.edit-json.preview", request);
    receipts["preview-receipt.json"] = await writeReceipt(destination, "preview-receipt.json", {
      schemaVersion: 1, projectId, sequenceId, baseRevision: revision, planDigest: preview.planDigest,
    });
    const executed = await call("headless.edit-json.execute", { ...request, approved: true, planDigest: preview.planDigest });
    const target = { provider: "final-cut", libraryUid: "disposable-library", eventUid: "disposable-event",
      projectUid: `qa-${randomUUID()}`, sequenceUid: `qa-${randomUUID()}`, materialization: "versioned" };
    result = await call("headless.fcpxml.export", { projectId, sequenceId, expectedRevision: executed.after.timeline.revision,
      outputPath: artifactPath, target });
    if (!result.artifact?.verified) throw new Error("ARTIFACT_INVALID: production export was not verified");
    receipts["execution-receipt.json"] = await writeReceipt(destination, "execution-receipt.json", {
      schemaVersion: 1, projectId, sequenceId, planDigest: preview.planDigest, approved: true,
      committed: executed.committed, revision: executed.after.timeline.revision,
      export: { target, verified: result.artifact.verified, digest: result.artifact.digest,
        sha256: createHash("sha256").update(await readFile(artifactPath)).digest("hex") },
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  await verifyPreparedArtifact(artifactPath, destination);
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const sourceRecords = await Promise.all(media.map(async ({ filename, id }) => ({ filename, mediaId: id, sha256: await sha(join(destination, filename)) })));
  const git = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const dirty = Boolean((await run("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim());
  const packageVersion = (JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { version: string }).version;
  const ffmpegVersion = (await run(ffmpeg, ["-version"])).stdout.split("\n")[0];
  const osVersion = process.platform === "darwin" ? (await run("sw_vers", ["-productVersion"])).stdout.trim() : `${process.platform} ${osRelease()}`;
  const manifestPath = join(destination, "reference.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, candidate: { commit: git, dirty, framekitVersion: packageVersion },
    environment: { nodeVersion: process.version, ffmpegVersion, osVersion, finalCutVersion: "UNVERIFIED" },
    sources: sourceRecords, receipts, artifact: { filename: "edit.fcpxml", sha256: await sha(artifactPath), revision: result.provenance.revision },
    expected: { sourceOrder: ["red.mp4", "green.mp4", "blue.mp4"], sourceStartSeconds: 1, clipDurationSeconds: 1,
      durationSeconds: 3, frameRate: "30/1", frameCount: 90,
      boundaryFrames: [{ frameNumber: 29, color: "red" }, { frameNumber: 30, color: "green" }, { frameNumber: 59, color: "green" }, { frameNumber: 60, color: "blue" }],
      samples: [{ timeSeconds: 0.5, color: "red" }, { timeSeconds: 1.5, color: "green" }, { timeSeconds: 2.5, color: "blue" }],
      title: { text: "FRAMEKIT QA", startSeconds: 0, durationSeconds: 1 }, music: { frequencyHz: 880, gainDb: -12 } },
    evidence: { artifact: "PASS", nativeImport: "UNVERIFIED", finalCutExport: "UNVERIFIED", titleEditability: "UNVERIFIED" },
  }, null, 2)}\n`, { flag: "wx" });
  return { artifactPath, manifestPath, nativeImport: "UNVERIFIED" as const, finalCutExport: "UNVERIFIED" as const };
}

/** Compare the generated FCPXML with fixed source, timing, title and music expectations. */
export async function verifyPreparedArtifact(artifactPath: string, fixtureDirectory: string): Promise<void> {
  const snapshot = await new FcpxmlDocumentAdapter(artifactPath).readProject();
  const frameDuration = snapshot.timeline.frameDuration;
  if (!frameDuration || BigInt(frameDuration.value) * 30n !== BigInt(frameDuration.timescale)) {
    throw new Error("ARTIFACT_INVALID: sequence frame duration differs from 1/30s");
  }
  const sourceFor = (id: string | undefined) => snapshot.media.find((item) => item.mediaId === id)?.source;
  const expected = ["red.mp4", "green.mp4", "blue.mp4"].map((name) => join(resolve(fixtureDirectory), name));
  const clips = snapshot.timeline.clips.filter((clip) => clip.track === 0);
  if (clips.length !== 3 || clips.some((clip, index) => sourceFor(clip.mediaId) !== expected[index]
    || clip.start !== index || clip.sourceStart !== 1 || clip.duration !== 1)) {
    throw new Error("ARTIFACT_INVALID: source order or trimmed ranges differ from the independent reference");
  }
  const title = snapshot.timeline.storyElements.find((element) => element.kind === "title");
  if (!title || title.text !== "FRAMEKIT QA" || title.start !== 0 || title.duration !== 1) {
    throw new Error("ARTIFACT_INVALID: title text or timing differs from the independent reference");
  }
  const music = snapshot.timeline.clips.filter((clip) => sourceFor(clip.mediaId) === join(resolve(fixtureDirectory), "music.wav"));
  if (music.length !== 1 || music[0]!.start !== 0 || music[0]!.sourceStart !== 0 || music[0]!.duration !== 3
    || music[0]!.role !== "music" || music[0]!.gainDb !== -12) {
    throw new Error("ARTIFACT_INVALID: music source or range differs from the independent reference");
  }
}

/** Inspect a supplied movie and leave native provenance and human observations unresolved. */
export async function verifyManualExport(fixtureDirectory: string, exportPath: string, outputDirectory: string) {
  const fixture = resolve(fixtureDirectory);
  const destination = resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(join(fixture, "reference.json"), "utf8")) as {
    schemaVersion: number;
    sources: Array<{ filename: string; sha256: string }>;
    artifact: { filename: string; sha256: string };
    expected: { sourceOrder: string[]; sourceStartSeconds: number; clipDurationSeconds: number; durationSeconds: number;
      title: { text: string; startSeconds: number; durationSeconds: number }; music: { frequencyHz: number; gainDb: number } };
  };
  const names = ["red.mp4", "green.mp4", "blue.mp4", "music.wav"];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)
    || JSON.stringify(manifest.sources.map((source) => source.filename)) !== JSON.stringify(names)
    || manifest.artifact?.filename !== "edit.fcpxml"
    || JSON.stringify(manifest.expected?.sourceOrder) !== JSON.stringify(names.slice(0, 3))
    || manifest.expected.sourceStartSeconds !== 1 || manifest.expected.clipDurationSeconds !== 1 || manifest.expected.durationSeconds !== 3
    || manifest.expected.title?.text !== "FRAMEKIT QA" || manifest.expected.title.startSeconds !== 0 || manifest.expected.title.durationSeconds !== 1
    || manifest.expected.music?.frequencyHz !== 880 || manifest.expected.music.gainDb !== -12) {
    throw new Error("REFERENCE_INVALID: unsupported or changed independent reference");
  }
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const checkSources = async () => {
    for (const source of manifest.sources) {
      if (!/^[a-f0-9]{64}$/.test(source.sha256) || await sha(join(fixture, source.filename)) !== source.sha256) {
        throw new Error(`SOURCE_CHANGED: ${source.filename}`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.artifact.sha256) || await sha(join(fixture, manifest.artifact.filename)) !== manifest.artifact.sha256) {
      throw new Error("ARTIFACT_CHANGED: edit.fcpxml");
    }
  };
  await checkSources();
  const movieDigest = await sha(exportPath);
  await mkdir(destination); // Existing reports are never replaced.
  const observed = await measureExport(exportPath);
  const titleFramePath = join(destination, "title-frame.png");
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", "-ss", "0.5", "-i", exportPath, "-frames:v", "1", titleFramePath]);
  await checkSources();
  if (await sha(exportPath) !== movieDigest) throw new Error("EXPORT_CHANGED: video changed during inspection");
  const report = { schemaVersion: 1, exportSha256: movieDigest, artifactSha256: manifest.artifact.sha256,
    observed, measurements: evaluateExportMeasurements(observed), titleVisibility: "UNVERIFIED" as const,
    titleFramePath, limitation: "Media measurements alone do not prove a Final Cut import, export, or title editability." };
  await writeFile(join(destination, "observation.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

async function main(args: string[]): Promise<void> {
  const usage = [
    "Usage: node --import tsx scripts/manual-import-qa.ts prepare NEW_DIRECTORY",
    "       node --import tsx scripts/manual-import-qa.ts inspect FIXTURE_DIRECTORY VIDEO NEW_REPORT_DIRECTORY",
    "       node --import tsx scripts/manual-import-qa.ts inspect-dissolve VIDEO NEW_REPORT_DIRECTORY",
    "       node --import tsx scripts/manual-import-qa.ts compare-dissolve REFERENCE_STEREO VIDEO_MONO NEW_REPORT_DIRECTORY",
    "These commands never operate Final Cut; native import, title editability and export provenance remain UNVERIFIED.",
  ].join("\n");
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${usage}\n`); return; }
  if (args[0] === "prepare" && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await prepareManualImportFixture(args[1]!), null, 2)}\n`);
    return;
  }
  if (args[0] === "inspect" && args.length === 4) {
    const report = await verifyManualExport(args[1]!, args[2]!, args[3]!);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.measurements.status !== "PASS") process.exitCode = 1;
    return;
  }
  if (args[0] === "inspect-dissolve" && args.length === 3) {
    const report = await inspectDissolveExport(args[1]!, args[2]!);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.measurements.status !== "PASS") process.exitCode = 1;
    return;
  }
  if (args[0] === "compare-dissolve" && args.length === 4) {
    const report = await compareDissolveVideos(args[1]!, args[2]!, args[3]!);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.comparison.status !== "PASS") process.exitCode = 1;
    return;
  }
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
