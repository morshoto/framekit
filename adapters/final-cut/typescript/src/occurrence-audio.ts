import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { canonicalSnapshotDigest, sameMediaSourceIdentity } from "@framekit/runtime";
import type {
  AnalysisInput, AnalyzerDescriptor, AudioAnalysis, AudioAnalyzer,
  ContextRevision, MediaSourceIdentity, ProjectSnapshot, TimeRange,
} from "@framekit/runtime";

const execFile = promisify(execFileCallback);

export interface OccurrenceAudioExportBinding {
  requestId: string;
  scope: "isolated-occurrence";
  origin: "editor-export";
  projectId: string;
  sequenceId: string;
  canonicalDigest: string;
  revision: ContextRevision;
  occurrenceId: string;
  sourceIdentity: MediaSourceIdentity;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  gainDb: number;
  effectScope: "gain-only";
}

/**
 * Must export the observed occurrence alone, after its native gain, as PCM.
 * A receipt describes independently observed export state, not an echoed intent.
 * No role remix, channel remap, normalization, effects, or source-file fallback.
 * After abort, settle only when export is terminal and cannot write output again.
 * The bundled unbound Share exporter does not implement this contract.
 */
export interface OccurrenceAudioExporter {
  readonly descriptor: AnalyzerDescriptor;
  export(request: {
    binding: OccurrenceAudioExportBinding;
    outputPath: string;
    signal: AbortSignal;
  }): Promise<{ binding: OccurrenceAudioExportBinding; outputDigest: string }>;
}

export interface FinalCutOccurrenceAudioAnalyzerOptions {
  exporter?: OccurrenceAudioExporter;
  readSnapshot: () => Promise<ProjectSnapshot>;
  temporaryRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Meters exported samples; never renders source media or predicts post-gain levels. */
export class FinalCutOccurrenceAudioAnalyzer implements AudioAnalyzer {
  public readonly descriptor: AnalyzerDescriptor = { id: "final-cut.occurrence-audio", provider: "ffmpeg.ebur128", version: "1" };
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(private readonly options: FinalCutOccurrenceAudioAnalyzerOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0
      || !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("ANALYZER_SETUP_REQUIRED: invalid occurrence audio resource limits");
    }
  }

  public async analyze(rawInput: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis> {
    const exporter = this.options.exporter;
    if (!exporter || !rawInput.occurrenceId) {
      throw new Error("OCCURRENCE_SIGNAL_UNAVAILABLE: a bound isolated-occurrence native exporter is required");
    }
    const exporterIdentity = structuredClone(exporter.descriptor);
    if (!exporterIdentity.id?.trim() || !exporterIdentity.provider?.trim() || !exporterIdentity.version?.trim()) {
      throw new Error("OCCURRENCE_SIGNAL_UNAVAILABLE: exporter identity and version are required");
    }
    const input = structuredClone(rawInput);
    const binding = createBinding(input, range);
    await this.assertCurrent(binding);
    await assertSource(binding.sourceIdentity);
    const directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), "occurrence-signal-"));
    const outputPath = join(directory, "isolated.wav");
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Do not race this promise against a timer and delete an output that a
      // still-running native export could write later. The port must settle
      // after terminal cancellation; abort never establishes native quiescence.
      const receipt = await exporter.export({ binding: structuredClone(binding), outputPath, signal: controller.signal });
      assertNotAborted(controller.signal);
      if (!isDeepStrictEqual(receipt.binding, binding) || !isDeepStrictEqual(exporter.descriptor, exporterIdentity)) {
        throw new Error("SIGNAL_BINDING_MISMATCH: native export evidence differs from the requested occurrence");
      }
      await assertOutput(outputPath, this.maxOutputBytes, receipt.outputDigest);
      await this.assertCurrent(binding);
      const measured = await meterPcm(outputPath, deadline);
      assertNotAborted(controller.signal);
      await assertOutput(outputPath, this.maxOutputBytes, receipt.outputDigest);
      await assertSource(binding.sourceIdentity);
      await this.assertCurrent(binding);
      const duration = binding.sourceRange.end - binding.sourceRange.start;
      if (Math.abs(measured.duration - duration) > 1 / measured.sampleRate + 1e-9) {
        throw new Error("AUDIO_OUTPUT_INVALID: exported sample duration differs from the full occurrence");
      }
      if (!Number.isFinite(measured.truePeakDb) || measured.silenceMs >= duration * 1000 - 1) {
        throw new Error("SILENT_SIGNAL: isolated output has no finite loudness measurement");
      }
      const invalidReason = duration < 0.4 ? "INSUFFICIENT_DURATION"
        : undefined;
      return {
        schemaVersion: 1, signalScope: "occurrence", occurrenceId: binding.occurrenceId,
        mediaId: input.media.mediaId, sourceIdentity: binding.sourceIdentity,
        requestedRange: binding.sourceRange, measuredRange: structuredClone(binding.sourceRange),
        revision: binding.revision, provider: structuredClone(this.descriptor),
        integratedLufs: measured.integratedLufs, truePeakDb: measured.truePeakDb,
        silenceMs: measured.silenceMs, analyzedDurationSeconds: duration,
        valid: !invalidReason, ...(invalidReason ? { invalidReason } : {}),
        signalProvenance: {
          scope: binding.scope, origin: binding.origin, requestId: binding.requestId,
          projectId: binding.projectId, sequenceId: binding.sequenceId,
          canonicalDigest: binding.canonicalDigest, sequenceRange: binding.sequenceRange,
          gainDb: binding.gainDb, effectScope: binding.effectScope,
          outputDigest: receipt.outputDigest, exporter: exporterIdentity, meterVersion: measured.version,
          sampleRate: measured.sampleRate, sampleCount: measured.sampleCount,
        },
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("OCCURRENCE_SIGNAL_TIMEOUT: export or measurement exceeded its deadline", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async assertCurrent(binding: OccurrenceAudioExportBinding): Promise<void> {
    const current = await this.options.readSnapshot();
    const media = current.media.filter(item => item.mediaId === binding.sourceIdentity.mediaId);
    if (current.projectId !== binding.projectId || current.timeline.id !== binding.sequenceId
      || !isDeepStrictEqual(current.revision, binding.revision)
      || media.length !== 1 || !sameMediaSourceIdentity(sourceIdentity(media[0]!), binding.sourceIdentity)
      || canonicalSnapshotDigest(current) !== binding.canonicalDigest) {
      throw new Error("ANALYSIS_STALE: canonical target or content changed during occurrence measurement");
    }
  }
}

function createBinding(input: AnalysisInput, range?: TimeRange): OccurrenceAudioExportBinding {
  const clips = input.project.timeline.clips.filter(clip => clip.id === input.occurrenceId);
  const clip = clips[0];
  const registered = input.project.media.filter(media => media.mediaId === input.media.mediaId);
  const identity = sourceIdentity(input.media);
  if (clips.length !== 1 || !clip || clip.mediaId !== input.media.mediaId
    || registered.length !== 1 || !sameMediaSourceIdentity(sourceIdentity(registered[0]!), identity)) {
    throw new Error("SIGNAL_BINDING_MISMATCH: occurrence or canonical source identity is ambiguous");
  }
  if (clip.enabled === false || clip.role === "title" || (clip.noiseReductionDb ?? 0) !== 0
    || (clip.fadeIn ?? 0) !== 0 || (clip.fadeOut ?? 0) !== 0 || !Number.isFinite(clip.gainDb ?? 0)) {
    throw new Error("UNSUPPORTED_PROCESSING: only enabled isolated gain-only audio is supported");
  }
  const sourceStartTime = clip.sourceStartTime ?? ((clip.sourceStart ?? 0) === 0 ? { value: "0", timescale: "1" } : undefined);
  if (!sourceStartTime) throw new Error("RANGE_MISMATCH: exact canonical source start is required");
  const sourceStart = seconds(sourceStartTime);
  const start = seconds(clip.startTime);
  const duration = seconds(clip.durationTime);
  const sourceRange: TimeRange = { start: sourceStart, end: sourceStart + duration,
    startTime: structuredClone(sourceStartTime), durationTime: structuredClone(clip.durationTime) };
  if (![sourceStart, start, duration].every(Number.isFinite) || sourceStart < 0 || start < 0 || duration <= 0
    || (input.media.duration !== undefined && sourceRange.end > input.media.duration + 1e-9)
    || (range && (range.start !== sourceRange.start || range.end !== sourceRange.end))) {
    throw new Error("RANGE_MISMATCH: measurement must cover the complete canonical occurrence source range");
  }
  if (!identity.sourceDigest || !/^(sha256:)?[a-f0-9]{64}$/.test(identity.sourceDigest)) {
    throw new Error("OCCURRENCE_SIGNAL_UNAVAILABLE: a canonical SHA-256 source digest is required");
  }
  return {
    requestId: randomUUID(), scope: "isolated-occurrence", origin: "editor-export",
    projectId: input.project.projectId, sequenceId: input.project.timeline.id,
    canonicalDigest: canonicalSnapshotDigest(input.project), revision: structuredClone(input.project.revision),
    occurrenceId: clip.id, sourceIdentity: identity, sourceRange,
    sequenceRange: { start, end: start + duration, startTime: structuredClone(clip.startTime), durationTime: structuredClone(clip.durationTime) },
    gainDb: clip.gainDb ?? 0, effectScope: "gain-only",
  };
}

function sourceIdentity(media: AnalysisInput["media"]): MediaSourceIdentity {
  return { mediaId: media.mediaId, source: media.source, ...(media.sourceDigest ? { sourceDigest: media.sourceDigest } : {}),
    ...(media.mediaKind ? { mediaKind: media.mediaKind } : {}), ...(media.duration !== undefined ? { duration: media.duration } : {}) };
}

function seconds(time: { value: string; timescale: string }): number {
  if (!/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale) || BigInt(time.timescale) <= 0n) return NaN;
  return Number(time.value) / Number(time.timescale);
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function assertSource(identity: MediaSourceIdentity): Promise<void> {
  try {
    if (!isAbsolute(identity.source) || (await fileDigest(identity.source)).replace(/^sha256:/, "") !== identity.sourceDigest?.replace(/^sha256:/, "")) {
      throw new Error("local source bytes do not match the canonical source digest");
    }
  } catch (error) {
    throw new Error("ANALYZER_SOURCE_CHANGED: canonical local source is unreadable or has changed", { cause: error });
  }
}

async function assertOutput(path: string, limit: number, expectedDigest: string): Promise<void> {
  const file = await lstat(path).catch(error => { throw new Error("AUDIO_OUTPUT_INVALID: isolated output is unavailable", { cause: error }); });
  if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > limit) {
    throw new Error("AUDIO_OUTPUT_INVALID: isolated output must be a nonempty regular file within the configured limit");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest) || await fileDigest(path) !== expectedDigest) {
    throw new Error("OUTPUT_CHANGED: exported bytes differ from the native receipt");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("OCCURRENCE_SIGNAL_TIMEOUT: native export was aborted");
}

async function meterPcm(path: string, deadline: number) {
  const run = (program: string, args: string[]) => execFile(program, args, {
    timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]);
    const streams = JSON.parse(stdout).streams as Array<Record<string, unknown>>;
    if (!Array.isArray(streams) || streams.length !== 1) throw new Error("expected one isolated audio stream");
    const audio = streams[0]!;
    if (audio.codec_type !== "audio" || !/^pcm_[sf](16|24|32|64)le$/.test(String(audio.codec_name))
      || ![1, 2].includes(Number(audio.channels))) throw new Error("expected mono or stereo PCM with no other streams");
    const sampleRate = Number(audio.sample_rate);
    const duration = Number(audio.duration_ts) * secondsTimebase(String(audio.time_base));
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("missing sample duration");
    const version = (await run("ffmpeg", ["-version"])).stdout.split("\n")[0]!;
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", path, "-map", "0:a:0", "-af",
      "silencedetect=noise=-60dB:d=0.1,ebur128=peak=true:framelog=verbose,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Number_of_samples", "-f", "null", "-"]);
    const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
    const integrated = summary.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?)/)?.[1];
    const peak = summary.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?|-inf)/)?.[1];
    if (integrated === undefined || peak === undefined || !version.startsWith("ffmpeg version")) throw new Error("missing loudness or true-peak summary");
    const samples = Number(stderr.match(/Number of samples:\s+(\d+)/)?.[1]);
    if (!Number.isSafeInteger(samples) || samples <= 0 || Math.abs(samples / sampleRate - duration) > 1 / sampleRate + 1e-9) {
      throw new Error("decoded sample count differs from the exported duration");
    }
    const silenceMs = [...stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)]
      .reduce((sum, match) => sum + Number(match[1]) * 1000, 0);
    if (silenceMs > duration * 1000 + 1) throw new Error("invalid silence duration");
    return { integratedLufs: Number(integrated), truePeakDb: peak === "-inf" ? -Infinity : Number(peak),
      silenceMs, duration, sampleRate, sampleCount: samples, version };
  } catch (error) {
    throw new Error(`AUDIO_OUTPUT_INVALID: exported PCM metering failed: ${String(error)}`, { cause: error });
  }
}

function secondsTimebase(value: string): number {
  const match = value.match(/^(\d+)\/(\d+)$/);
  return match ? Number(match[1]) / Number(match[2]) : NaN;
}
