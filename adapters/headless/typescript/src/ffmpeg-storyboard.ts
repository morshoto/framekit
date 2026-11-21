import { execFile, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TimelineIr } from "@framekit/runtime";
import { escapeFilterValue, resolveFontFile } from "./ffmpeg-renderer.js";

const execFileAsync = promisify(execFile);
async function run(file: string, args: string[], options: ExecFileOptions): Promise<void> {
  try {
    await execFileAsync(file, args, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("DEPENDENCY_MISSING: ffmpeg is required; install FFmpeg and ensure ffmpeg is on PATH", { cause: error });
    if ((error as Error).name === "AbortError") throw error;
    throw new Error("HEADLESS_STORYBOARD_FAILED: FFmpeg could not create the storyboard; check the media and FFmpeg installation", { cause: error });
  }
}
const MAX_SAMPLES = 12;
const MAX_WIDTH = 640;
const MAX_HEIGHT = 360;

type Sample = { kind: "shot" | "title"; id: string; occurrenceId: string; mediaId: string; sourceDigest: string; timelineSeconds: number; sourceSeconds: number };

/** Renders a bounded set of individual frames, without writing a movie or changing sources. */
export class FfmpegStoryboardRenderer {
  constructor(private readonly options: { ffmpegPath?: string; temporaryDirectory?: string } = {}) {}

  async render(timeline: TimelineIr, dimensions: { width: number; height: number }, signal?: AbortSignal): Promise<{ data: string; mimeType: "image/png"; samples: Sample[]; limitations: string[] }> {
    signal?.throwIfAborted();
    const sequence = timeline.sequence;
    if (sequence.transitions?.length || sequence.storyElements.length || sequence.captions.length || sequence.occurrences.some((item) => item.track === 0 && (item.transform || item.enabled === false))) {
      throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: transitions, gaps, disabled clips and transforms cannot be sampled faithfully");
    }
    const clips = sequence.occurrences.filter((item) => item.track === 0 && (!item.role || item.role === "video")).sort((a, b) => seconds(a.startTime) - seconds(b.startTime));
    const titles = sequence.titles ?? [];
    if (!clips.length || clips.length + titles.length > MAX_SAMPLES) throw new Error(`HEADLESS_STORYBOARD_LIMIT: expected 1 to ${MAX_SAMPLES} total shots and titles`);
    if (sequence.occurrences.some((item) => item.track === 0 && item.role && item.role !== "video") || clips.some((item, index) => Math.abs(seconds(item.startTime) - (index ? seconds(clips[index - 1]!.startTime) + seconds(clips[index - 1]!.durationTime) : 0)) > 1e-7)) throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: primary clips must form a contiguous storyline");
    if (sequence.occurrences.some((item) => item.track !== 0 && item.role !== "audio" && item.role !== "music")) throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: visual overlays cannot be sampled faithfully");
    const frameDuration = seconds(sequence.frameDuration);
    const scale = Math.min(MAX_WIDTH / dimensions.width, MAX_HEIGHT / dimensions.height);
    const width = Math.max(2, Math.floor(dimensions.width * scale / 2) * 2);
    const height = Math.max(2, Math.floor(dimensions.height * scale / 2) * 2);
    const resources = new Map(timeline.resources.map((resource) => [resource.id, resource]));
    const samples: Sample[] = [];
    const add = (kind: Sample["kind"], id: string, time: number) => {
      const clip = clips.find((item) => time >= seconds(item.startTime) - 1e-8 && time < seconds(item.startTime) + seconds(item.durationTime) - 1e-8);
      const resource = clip?.mediaId ? resources.get(clip.mediaId) : undefined;
      if (!clip || !resource?.source || resource.sourceKind !== "local-file" || !resource.sourceDigest) throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: sample has no registered video source");
      samples.push({ kind, id, occurrenceId: clip.id, mediaId: resource.id, sourceDigest: resource.sourceDigest, timelineSeconds: time, sourceSeconds: seconds(clip.sourceStartTime ?? { value: "0", timescale: "1" }) + time - seconds(clip.startTime) });
    };
    for (const clip of clips) add("shot", clip.id, seconds(clip.startTime));
    for (const title of titles) {
      const midpoint = seconds(title.startTime) + seconds(title.durationTime) / 2;
      const sampleTime = Math.floor((midpoint + 1e-8) / frameDuration) * frameDuration;
      if (sampleTime < seconds(title.startTime) || sampleTime >= seconds(title.startTime) + seconds(title.durationTime)) {
        throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: title midpoint has no sample on the sequence frame grid");
      }
      add("title", title.id, sampleTime);
    }
    samples.sort((a, b) => a.timelineSeconds - b.timelineSeconds || a.kind.localeCompare(b.kind));
    const identities = new Map<string, string>();
    for (const sample of samples) {
      const resource = resources.get(sample.mediaId)!;
      identities.set(resolve(resource.source!), sample.sourceDigest);
    }
    const checkSources = async () => {
      for (const [path, expected] of identities) {
        signal?.throwIfAborted();
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || await digest(path, signal) !== expected) throw new Error("HEADLESS_STORYBOARD_SOURCE_CHANGED: source identity does not match registered media");
      }
    };
    await checkSources();
    const dir = await mkdtemp(join(this.options.temporaryDirectory ?? tmpdir(), "framekit-storyboard-"));
    try {
      const frames: string[] = [];
      for (const [index, sample] of samples.entries()) {
        signal?.throwIfAborted();
        const resource = resources.get(sample.mediaId)!;
        const activeTitles = titles.filter((title) => sample.timelineSeconds >= seconds(title.startTime) && sample.timelineSeconds < seconds(title.startTime) + seconds(title.durationTime));
        const filters = [`scale=${width}:${height}:force_original_aspect_ratio=disable`];
        for (const [titleIndex, title] of activeTitles.entries()) {
          if (title.style || title.position) throw new Error("HEADLESS_STORYBOARD_UNSUPPORTED: styled titles are not supported");
          const filename = `title-${index}-${titleIndex}.txt`;
          await writeFile(join(dir, filename), title.text, "utf8");
          const fontSize = Math.max(1, Math.round(32 * scale));
          const font = resolveFontFile(process.env.FRAMEKIT_RENDER_FONT);
          filters.push(`drawtext=${font ? `fontfile='${escapeFilterValue(font)}':` : ""}textfile='${filename}':expansion=none:fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2`);
        }
        const frame = join(dir, `${index}.png`);
        await run(this.options.ffmpegPath ?? process.env.FFMPEG_BIN ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(sample.sourceSeconds), "-i", resolve(resource.source!), "-vf", filters.join(","), "-frames:v", "1", "-threads", "1", "-y", frame], { cwd: dir, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
        frames.push(frame);
      }
      const columns = Math.min(3, frames.length);
      const rows = Math.ceil(frames.length / columns);
      const sheet = join(dir, "sheet.png");
      const input = frames.flatMap((frame) => ["-i", frame]);
      const layout = frames.map((_, index) => `${(index % columns) * width}_${Math.floor(index / columns) * height}`).join("|");
      const filter = frames.length === 1 ? "[0:v]null[out]" : `${frames.map((_, index) => `[${index}:v]`).join("")}xstack=inputs=${frames.length}:layout=${layout}:fill=black[out]`;
      await run(this.options.ffmpegPath ?? process.env.FFMPEG_BIN ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-threads", "1", "-y", sheet], { cwd: dir, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
      const bytes = await readFile(sheet);
      if (bytes.length > 8 * 1024 * 1024) throw new Error("HEADLESS_STORYBOARD_LIMIT: contact sheet exceeds 8 MiB");
      await checkSources();
      signal?.throwIfAborted();
      return { data: bytes.toString("base64"), mimeType: "image/png", samples, limitations: [`${width}x${height} pixels per sample; ${columns} columns and ${rows} rows in sample order`, "Only shot starts and title midpoints are sampled; motion, audio and unsampled frames are not represented.", "Source frames are sought independently; source and output frame-rate conversion can select different nearby frames."] };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function seconds(value: { value: string; timescale: string }): number {
  return Number(value.value) / Number(value.timescale);
}

async function digest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
