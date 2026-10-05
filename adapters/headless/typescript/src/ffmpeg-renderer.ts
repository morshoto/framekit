import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, link, lstat, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createFramekitRenderResult,
  type FramekitRenderCapabilityReport,
  type FramekitRenderFeature,
  type FramekitRenderFormat,
  type FramekitRenderPlan,
  type FramekitRenderProvider,
  type FramekitRenderProviderResult,
  type FramekitRenderRequest,
  type TimelineIr,
  type TimelineIrOccurrence,
  type TimelineIrResource,
  type TimelineIrTransition,
} from "@framekit/runtime";

const execFileAsync = promisify(execFile);

export interface FfmpegTimelineRendererOptions {
  ffmpegPath?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
}

export type FfmpegRenderErrorCode =
  | "HEADLESS_RENDER_UNAVAILABLE"
  | "HEADLESS_RENDER_UNSUPPORTED"
  | "HEADLESS_RENDER_MEDIA_MISSING"
  | "HEADLESS_RENDER_MEDIA_CHANGED"
  | "HEADLESS_RENDER_OUTPUT_EXISTS"
  | "HEADLESS_RENDER_OUTPUT_INVALID"
  | "HEADLESS_RENDER_PLAN_MISMATCH"
  | "HEADLESS_RENDER_FAILED";

export class FfmpegRenderError extends Error {
  public constructor(
    public readonly code: FfmpegRenderErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FfmpegRenderError";
  }
}

/**
 * The first provider-neutral concrete renderer. It consumes only a validated
 * Timeline IR render plan and treats local source files as immutable inputs.
 */
export class FfmpegTimelineRenderer implements FramekitRenderProvider {
  public readonly id = "ffmpeg-headless";
  public readonly version: string;
  private readonly ffmpegPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fontFile?: string;

  public constructor(options: FfmpegTimelineRendererOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_BIN ?? "ffmpeg";
    this.version = options.version ?? "0.1.0";
    this.environment = { ...process.env, ...options.env };
    this.fontFile = resolveFontFile(options.env?.FRAMEKIT_RENDER_FONT ?? process.env.FRAMEKIT_RENDER_FONT);
  }

  public capabilities(request: FramekitRenderRequest): FramekitRenderCapabilityReport {
    const timeline = request.timeline;
    return {
      renderer: { id: this.id, version: this.version },
      features: {
        "local-media": supportsLocalMedia(timeline) ? "supported" : "unsupported",
        "structural-edits": supportsStructuralEdits(timeline) ? "supported" : "unsupported",
        "audio-gain": supportsAudioGain(timeline) ? "supported" : "unsupported",
        transform: supportsTransforms(timeline) ? "supported" : "unsupported",
        titles: supportsTitles(timeline) ? "supported" : "unsupported",
        "cross-dissolve": supportsCrossDissolve(timeline) ? "supported" : "unsupported",
      },
    };
  }

  public async render(plan: FramekitRenderPlan): Promise<FramekitRenderProviderResult> {
    if (plan.renderer.id !== this.id || plan.renderer.version !== this.version) {
      throw new FfmpegRenderError("HEADLESS_RENDER_PLAN_MISMATCH", "render plan is bound to another renderer version");
    }
    const unavailable = plan.requiredFeatures.filter((feature) => plan.capabilities.features[feature] !== "supported");
    if (unavailable.length > 0) {
      throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `required features are unavailable: ${unavailable.join(", ")}`);
    }

    const model = await prepareRenderModel(plan);
    const outputPath = resolve(plan.parameters.outputPath);
    await assertOutputPath(outputPath, plan.parameters.overwrite ?? false, model.sourcePaths);
    const outputDirectory = dirname(outputPath);
    await access(outputDirectory).catch(() => {
      throw new FfmpegRenderError("HEADLESS_RENDER_OUTPUT_INVALID", `output directory does not exist: ${outputDirectory}`);
    });
    const stagingDirectory = await mkdtemp(join(outputDirectory, ".framekit-render-"));
    const stagingPath = join(stagingDirectory, `render.${plan.parameters.format}`);
    try {
      const args = buildFfmpegArguments(model, stagingPath, this.fontFile);
      try {
        await execFileAsync(this.ffmpegPath, args, {
          cwd: process.cwd(),
          env: this.environment,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new FfmpegRenderError("HEADLESS_RENDER_FAILED", detail);
      }
      if (!(await isRegularFile(stagingPath))) {
        throw new FfmpegRenderError("HEADLESS_RENDER_FAILED", "FFmpeg completed without producing an output file");
      }
      await assertSourcesUnchanged(model);
      if (plan.parameters.overwrite ?? false) {
        await rename(stagingPath, outputPath);
      } else {
        try {
          await link(stagingPath, outputPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new FfmpegRenderError("HEADLESS_RENDER_OUTPUT_EXISTS", `render output already exists: ${outputPath}`);
          }
          throw error;
        }
        await unlink(stagingPath);
      }
      return createFramekitRenderResult(plan, {
        path: plan.parameters.outputPath,
        format: plan.parameters.format,
      });
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

interface RenderModel {
  timeline: TimelineIr;
  occurrences: TimelineIrOccurrence[];
  resources: Map<string, TimelineIrResource>;
  sourcePaths: string[];
  duration: number;
  frameRate: number;
  width: number;
  height: number;
  format: FramekitRenderFormat;
  sourceIdentities: Array<{ path: string; digest: string }>;
}

async function prepareRenderModel(plan: FramekitRenderPlan): Promise<RenderModel> {
  const timeline = structuredClone(plan.timeline);
  const sequence = timeline.sequence;
  const occurrences = [...sequence.occurrences].sort((left, right) => compareSeconds(left.startTime, right.startTime));
  if (!supportsStructuralEdits(timeline)) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "markers, captions, story elements, disabled clips, and non-primary tracks are not supported");
  }
  if (!supportsTransforms(timeline) || !supportsTitles(timeline) || !supportsCrossDissolve(timeline)) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "Timeline IR contains unsupported renderer semantics");
  }
  if (occurrences.length === 0) throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "at least one video occurrence is required");

  const duration = rationalSeconds(sequence.durationTime, "sequence duration");
  const frameRate = 1 / rationalSeconds(sequence.frameDuration, "sequence frame duration");
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "sequence duration and frame rate must be finite and positive");
  }
  if (!Number.isSafeInteger(plan.parameters.width) || !Number.isSafeInteger(plan.parameters.height)) {
    throw new FfmpegRenderError("HEADLESS_RENDER_OUTPUT_INVALID", "output dimensions must be safe integers");
  }

  const resources = new Map(timeline.resources.map((resource) => [resource.id, resource]));
  const sourcePaths: string[] = [];
  const sourceIdentities: Array<{ path: string; digest: string }> = [];
  const audioAvailability = new Set<boolean>();
  let previousEnd = 0;
  for (const occurrence of occurrences) {
    if (occurrence.track !== 0 || occurrence.role === "audio" || occurrence.role === "music" || occurrence.role === "title") {
      throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `occurrence role or track is not renderable: ${occurrence.id}`);
    }
    if (occurrence.enabled === false || occurrence.attachedTo) {
      throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `occurrence has unsupported state: ${occurrence.id}`);
    }
    const start = rationalSeconds(occurrence.startTime, `${occurrence.id}.startTime`);
    const clipDuration = rationalSeconds(occurrence.durationTime, `${occurrence.id}.durationTime`);
    if (Math.abs(start - previousEnd) > 1e-7) {
      throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `primary occurrences must be contiguous: ${occurrence.id}`);
    }
    previousEnd = start + clipDuration;
    const resource = occurrence.mediaId ? resources.get(occurrence.mediaId) : undefined;
    if (!resource) throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `occurrence has no registered media: ${occurrence.id}`);
    const source = await verifyResource(resource, occurrence, clipDuration);
    const sourcePath = source.path;
    audioAvailability.add(resource.metadata?.streams.some((stream) => stream.kind === "audio") ?? false);
    if (!sourcePaths.includes(sourcePath)) sourcePaths.push(sourcePath);
    if (!sourceIdentities.some((identity) => identity.path === source.path && identity.digest === source.digest)) {
      sourceIdentities.push(source);
    }
  }
  if (audioAvailability.size > 1) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "all primary occurrences must agree on audio availability");
  }
  if (Math.abs(previousEnd - duration) > 1e-7) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "occurrences do not cover the sequence duration");
  }
  const transitions = timeline.sequence.transitions ?? [];
  if (transitions.length > 1) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "the first FFmpeg provider supports one canonical cross-dissolve");
  }
  return {
    timeline,
    occurrences,
    resources,
    sourcePaths,
    duration,
    frameRate,
    width: plan.parameters.width,
    height: plan.parameters.height,
    format: plan.parameters.format,
    sourceIdentities,
  };
}

async function verifyResource(resource: TimelineIrResource, occurrence: TimelineIrOccurrence, duration: number): Promise<{ path: string; digest: string }> {
  if (resource.sourceKind !== "local-file" || !resource.source || !resource.sourceDigest) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `resource is not a registered local file: ${resource.id}`);
  }
  const sourcePath = resolve(resource.source);
  let details;
  try {
    details = await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FfmpegRenderError("HEADLESS_RENDER_MEDIA_MISSING", `registered source is missing: ${sourcePath}`);
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new FfmpegRenderError("HEADLESS_RENDER_MEDIA_MISSING", `registered source is not a regular file: ${sourcePath}`);
  }
  const actualDigest = await digestFile(sourcePath);
  if (actualDigest !== resource.sourceDigest) {
    throw new FfmpegRenderError("HEADLESS_RENDER_MEDIA_CHANGED", `registered source changed: ${sourcePath}`);
  }
  const video = resource.metadata?.streams.find((stream) => stream.kind === "video");
  if (!video?.width || !video.height) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `resource is missing video dimensions: ${resource.id}`);
  }
  const sourceStart = occurrence.sourceStartTime ? rationalSeconds(occurrence.sourceStartTime, `${occurrence.id}.sourceStartTime`) : 0;
  const sourceDuration = resource.metadata ? rationalSeconds(resource.metadata.durationTime, `${resource.id}.durationTime`) : 0;
  if (sourceStart < 0 || duration <= 0 || sourceStart + duration > sourceDuration + 1e-7) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `source range exceeds registered media: ${occurrence.id}`);
  }
  return { path: sourcePath, digest: actualDigest };
}

async function assertSourcesUnchanged(model: RenderModel): Promise<void> {
  for (const identity of model.sourceIdentities) {
    let details;
    try {
      details = await lstat(identity.path);
    } catch {
      throw new FfmpegRenderError("HEADLESS_RENDER_MEDIA_CHANGED", `registered source changed during rendering: ${identity.path}`);
    }
    if (!details.isFile() || details.isSymbolicLink() || await digestFile(identity.path) !== identity.digest) {
      throw new FfmpegRenderError("HEADLESS_RENDER_MEDIA_CHANGED", `registered source changed during rendering: ${identity.path}`);
    }
  }
}

function buildFfmpegArguments(model: RenderModel, stagingPath: string, fontFile?: string): string[] {
  const filters: string[] = [];
  const inputArguments: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  const fps = formatNumber(model.frameRate);

  for (const [index, occurrence] of model.occurrences.entries()) {
    const resource = model.resources.get(occurrence.mediaId!);
    const inputPath = resolve(resource!.source!);
    inputArguments.push("-i", inputPath);
    const sourceStart = occurrence.sourceStartTime ? rationalSeconds(occurrence.sourceStartTime, `${occurrence.id}.sourceStartTime`) : 0;
    const duration = rationalSeconds(occurrence.durationTime, `${occurrence.id}.durationTime`);
    const videoInput = `[${index}:v]`;
    const videoLabel = `clipv${index}`;
    filters.push(`${videoInput}trim=start=${formatNumber(sourceStart)}:duration=${formatNumber(duration)},setpts=PTS-STARTPTS,settb=AVTB,fps=${fps},${transformFilter(occurrence, resource!, model.width, model.height)}[${videoLabel}]`);
    videoLabels.push(`[${videoLabel}]`);
    const hasAudio = resource!.metadata?.streams.some((stream) => stream.kind === "audio") ?? false;
    if (hasAudio) {
      const audioLabel = `clipa${index}`;
      const gain = occurrence.gainDb ?? 0;
      filters.push(`${`[${index}:a]`}atrim=start=${formatNumber(sourceStart)}:duration=${formatNumber(duration)},asetpts=PTS-STARTPTS,aresample=48000,volume=${formatNumber(Math.pow(10, gain / 20))}[${audioLabel}]`);
      audioLabels.push(`[${audioLabel}]`);
    }
  }

  const transition = model.timeline.sequence.transitions?.[0];
  const videoBase = addVideoComposition(filters, videoLabels, model, transition);
  const videoOutput = addTitleOverlays(filters, videoBase, model, fontFile);
  let audioOutput: string | undefined;
  if (audioLabels.length > 0) audioOutput = addAudioComposition(filters, audioLabels, model, transition);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputArguments, "-filter_complex", filters.join(";")];
  args.push("-map", `[${videoOutput}]`, "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-r", fps);
  if (audioOutput) {
    args.push("-map", `[${audioOutput}]`, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1");
  }
  args.push("-map_metadata", "-1", "-t", formatNumber(model.duration), "-movflags", "+faststart", stagingPath);
  return args;
}

function addVideoComposition(
  filters: string[],
  labels: string[],
  model: RenderModel,
  transition: TimelineIrTransition | undefined,
): string {
  if (labels.length === 1) {
    const output = "video-base";
    filters.push(`${labels[0]}tpad=stop_mode=clone:stop_duration=0[${output}]`);
    return output;
  }
  if (transition) {
    const duration = rationalSeconds(transition.durationTime, `${transition.id}.durationTime`);
    const offset = rationalSeconds(model.occurrences[0]!.durationTime, "transition offset") - duration;
    if (offset < 0) throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", "transition duration exceeds the first occurrence duration");
    const output = "video-xfade";
    filters.push(`${labels[0]}${labels[1]}xfade=transition=fade:duration=${formatNumber(duration)}:offset=${formatNumber(offset)}[${output}]`);
    const padding = Math.max(0, model.duration - (model.duration - duration));
    filters.push(`[${output}]tpad=stop_mode=clone:stop_duration=${formatNumber(padding)}[${output}-padded]`);
    return `${output}-padded`;
  }
  const output = "video-concat";
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[${output}]`);
  return output;
}

function addAudioComposition(
  filters: string[],
  labels: string[],
  model: RenderModel,
  transition: TimelineIrTransition | undefined,
): string {
  if (labels.length === 1) {
    const output = "audio-base";
    filters.push(`${labels[0]}apad,atrim=duration=${formatNumber(model.duration)},asetpts=PTS-STARTPTS[${output}]`);
    return output;
  }
  if (transition) {
    const duration = rationalSeconds(transition.durationTime, `${transition.id}.durationTime`);
    const output = "audio-crossfade";
    filters.push(`${labels[0]}${labels[1]}acrossfade=d=${formatNumber(duration)}:c1=tri:c2=tri[${output}]`);
    filters.push(`[${output}]apad,atrim=duration=${formatNumber(model.duration)},asetpts=PTS-STARTPTS[${output}-padded]`);
    return `${output}-padded`;
  }
  const output = "audio-concat";
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[${output}]`);
  return output;
}

function addTitleOverlays(filters: string[], input: string, model: RenderModel, fontFile?: string): string {
  let current = input;
  for (const [index, title] of (model.timeline.sequence.titles ?? []).entries()) {
    const start = rationalSeconds(title.startTime, `${title.id}.startTime`);
    const end = start + rationalSeconds(title.durationTime, `${title.id}.durationTime`);
    const style = title.style;
    const color = escapeFilterValue(style?.color ?? "white");
    const size = formatNumber(style?.fontSize ?? 32);
    const x = title.position ? formatNumber(title.position.x) : style?.alignment === "left" ? "20" : style?.alignment === "right" ? "w-text_w-20" : "(w-text_w)/2";
    const y = title.position ? formatNumber(title.position.y) : "(h-text_h)/2";
    const output = `title-${index}`;
    const font = fontFile ? `fontfile='${escapeFilterValue(fontFile)}':` : "";
    filters.push(`[${current}]drawtext=${font}text='${escapeFilterValue(title.text)}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}:enable='between(t,${formatNumber(start)},${formatNumber(end)})'[${output}]`);
    current = output;
  }
  return current;
}

function transformFilter(occurrence: TimelineIrOccurrence, resource: TimelineIrResource, width: number, height: number): string {
  const transform = occurrence.transform;
  if (!transform) return `scale=${width}:${height}:force_original_aspect_ratio=disable`;
  const sourceVideo = resource.metadata!.streams.find((stream) => stream.kind === "video")!;
  const scaledWidth = evenDimension(sourceVideo.width! * transform.scaleX);
  const scaledHeight = evenDimension(sourceVideo.height! * transform.scaleY);
  const positionX = transform.positionX ?? 0;
  const positionY = transform.positionY ?? 0;
  if (scaledWidth >= width && scaledHeight >= height) {
    const cropX = clamp((scaledWidth - width) / 2 - positionX, 0, scaledWidth - width);
    const cropY = clamp((scaledHeight - height) / 2 - positionY, 0, scaledHeight - height);
    return `scale=${scaledWidth}:${scaledHeight},crop=${width}:${height}:${formatNumber(cropX)}:${formatNumber(cropY)}`;
  }
  return `scale=${scaledWidth}:${scaledHeight},pad=${width}:${height}:${formatNumber((width - scaledWidth) / 2 + positionX)}:${formatNumber((height - scaledHeight) / 2 + positionY)}:color=black`;
}

function supportsLocalMedia(timeline: TimelineIr): boolean {
  const resources = new Map(timeline.resources.map((resource) => [resource.id, resource]));
  return timeline.sequence.occurrences.every((occurrence) => {
    const resource = occurrence.mediaId ? resources.get(occurrence.mediaId) : undefined;
    return resource?.sourceKind === "local-file" && Boolean(resource.source) && Boolean(resource.sourceDigest);
  });
}

function supportsStructuralEdits(timeline: TimelineIr): boolean {
  return timeline.sequence.storyElements.length === 0
    && timeline.sequence.markers.length === 0
    && timeline.sequence.captions.length === 0
    && timeline.sequence.occurrences.length > 0
    && timeline.sequence.occurrences.every((occurrence) => occurrence.track === 0
      && occurrence.role !== "audio"
      && occurrence.role !== "music"
      && occurrence.role !== "title"
      && occurrence.enabled !== false
      && !occurrence.attachedTo);
}

function supportsAudioGain(timeline: TimelineIr): boolean {
  return timeline.sequence.occurrences.every((occurrence) => occurrence.gainDb === undefined || Number.isFinite(occurrence.gainDb));
}

function supportsTransforms(timeline: TimelineIr): boolean {
  return timeline.sequence.occurrences.every((occurrence) => !occurrence.transform || (
    Number.isFinite(occurrence.transform.scaleX)
    && Number.isFinite(occurrence.transform.scaleY)
    && occurrence.transform.scaleX > 0
    && occurrence.transform.scaleY > 0
    && [occurrence.transform.positionX, occurrence.transform.positionY, occurrence.transform.rotationDegrees].every((value) => value === undefined || Number.isFinite(value))
    && occurrence.transform.rotationDegrees === undefined
  ));
}

function supportsTitles(timeline: TimelineIr): boolean {
  return (timeline.sequence.titles ?? []).every((title) => !title.style || (
    title.style.fontFamily === undefined
    && (title.style.fontSize === undefined || (Number.isFinite(title.style.fontSize) && title.style.fontSize > 0))
  ));
}

function supportsCrossDissolve(timeline: TimelineIr): boolean {
  const transitions = timeline.sequence.transitions ?? [];
  return transitions.length <= 1
    && transitions.every((transition) => transition.kind === "cross-dissolve")
    && (transitions.length === 0 || timeline.sequence.occurrences.length === 2);
}

async function assertOutputPath(outputPath: string, overwrite: boolean, sourcePaths: string[]): Promise<void> {
  if (sourcePaths.includes(outputPath)) {
    throw new FfmpegRenderError("HEADLESS_RENDER_OUTPUT_INVALID", "render output must not overwrite a source media file");
  }
  if (!overwrite && await isRegularFile(outputPath)) {
    throw new FfmpegRenderError("HEADLESS_RENDER_OUTPUT_EXISTS", `render output already exists: ${outputPath}`);
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

function rationalSeconds(time: { value: string; timescale: string }, field: string): number {
  if (!/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale) || BigInt(time.timescale) <= 0n) {
    throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `invalid rational time: ${field}`);
  }
  const result = Number(BigInt(time.value)) / Number(BigInt(time.timescale));
  if (!Number.isFinite(result)) throw new FfmpegRenderError("HEADLESS_RENDER_UNSUPPORTED", `rational time is too large: ${field}`);
  return result;
}

function compareSeconds(left: { value: string; timescale: string }, right: { value: string; timescale: string }): number {
  const leftValue = BigInt(left.value) * BigInt(right.timescale);
  const rightValue = BigInt(right.value) * BigInt(left.timescale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(":", "\\:").replaceAll(",", "\\,").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("\n", "\\n");
}

function resolveFontFile(preferred?: string): string | undefined {
  const candidates = [
    preferred,
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}
