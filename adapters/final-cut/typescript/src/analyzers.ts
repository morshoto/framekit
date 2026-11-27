import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { bindSpeechAnalysis, sameMediaSourceIdentity, validateAudioAnalysisPayload } from "@framekit/runtime";
import type {
  AnalysisInput,
  AudioAnalysis,
  AudioAnalyzer,
  AnalyzerDescriptor,
  MetadataAnalysis,
  MetadataAnalyzer,
  SpeechAnalysis,
  SpeechAnalyzer,
  MediaSourceIdentity,
  TimeRange,
  VisualAnalysis,
  VisualAnalyzer,
} from "@framekit/runtime";

export interface CommandAnalyzerOptions {
  command: string;
  timeoutMs?: number;
  providerVersion?: string;
  modelIdentity?: string;
  /** Optional operator-pinned asset; opaque commands may still load other files. */
  modelAsset?: { path: string; sha256: string };
  /** Optional pinned VAD detector asset; checked independently of speech weights. */
  vadModelAsset?: { path: string; sha256: string };
  requireVad?: boolean;
  /** Captured at construction and used for both execution and configuration identity. */
  environment?: Record<string, string | undefined>;
}

interface AnalyzerRequest extends AnalysisInput {
  range?: TimeRange;
}

export function createCommandAnalyzers(options: {
  speechCommand?: string;
  speechProviderVersion?: string;
  speechModelIdentity?: string;
  speechModelAssetPath?: string;
  speechModelAssetSha256?: string;
  speechVadModelAssetPath?: string;
  speechVadModelAssetSha256?: string;
  speechRequireVad?: boolean;
  audioCommand?: string;
  audioProviderVersion?: string;
  visualCommand?: string;
  metadataCommand?: string;
  timeoutMs?: number;
}): {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  metadataAnalyzer?: MetadataAnalyzer;
} {
  if ((options.speechModelAssetPath === undefined) !== (options.speechModelAssetSha256 === undefined)) {
    throw new Error("ANALYZER_SETUP_REQUIRED: both speech model asset path and SHA-256 are required");
  }
  if ((options.speechVadModelAssetPath === undefined) !== (options.speechVadModelAssetSha256 === undefined)) {
    throw new Error("ANALYZER_SETUP_REQUIRED: both VAD model asset path and SHA-256 are required");
  }
  return {
    ...(options.speechCommand ? {
      speechAnalyzer: new CommandSpeechAnalyzer({
        command: options.speechCommand,
        timeoutMs: options.timeoutMs,
        ...(options.speechProviderVersion ? { providerVersion: options.speechProviderVersion } : {}),
        ...(options.speechModelIdentity ? { modelIdentity: options.speechModelIdentity } : {}),
        ...(options.speechModelAssetPath !== undefined && options.speechModelAssetSha256 !== undefined
          ? { modelAsset: { path: options.speechModelAssetPath, sha256: options.speechModelAssetSha256 } } : {}),
        ...(options.speechVadModelAssetPath !== undefined && options.speechVadModelAssetSha256 !== undefined
          ? { vadModelAsset: { path: options.speechVadModelAssetPath, sha256: options.speechVadModelAssetSha256 } } : {}),
        ...(options.speechRequireVad ? { requireVad: true } : {}),
      }),
    } : {}),
    ...(options.audioCommand ? { audioAnalyzer: new CommandAudioAnalyzer({ command: options.audioCommand, timeoutMs: options.timeoutMs, providerVersion: options.audioProviderVersion }) } : {}),
    ...(options.visualCommand ? { visualAnalyzer: new CommandVisualAnalyzer({ command: options.visualCommand, timeoutMs: options.timeoutMs }) } : {}),
    ...(options.metadataCommand ? { metadataAnalyzer: new CommandMetadataAnalyzer({ command: options.metadataCommand, timeoutMs: options.timeoutMs }) } : {}),
  };
}

export class CommandSpeechAnalyzer implements SpeechAnalyzer {
  public readonly descriptor: AnalyzerDescriptor;
  public readonly capabilities: { transcription: true; vad: boolean };

  public constructor(private readonly options: CommandAnalyzerOptions) {
    this.options = captureCommandOptions(options);
    for (const asset of [this.options.modelAsset, this.options.vadModelAsset]) {
      if (asset && (!isAbsolute(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256))) {
        throw new Error("ANALYZER_SETUP_REQUIRED: model assets require absolute paths and lowercase SHA-256");
      }
    }
    if (options.requireVad === true && !options.providerVersion?.trim()) {
      throw new Error("ANALYZER_SETUP_REQUIRED: speech provider version is required when VAD is required");
    }
    this.descriptor = commandDescriptor(this.options, "speech");
    this.capabilities = { transcription: true, vad: options.requireVad === true };
  }

  public async verifyProviderIdentity(): Promise<void> {
    for (const asset of [this.options.modelAsset, this.options.vadModelAsset]) {
      if (!asset) continue;
      let actual: string;
      try { actual = await digestAnalyzerSource(asset.path, "model asset", this.options.timeoutMs ?? 120_000); }
      catch { throw new Error("ANALYZER_MODEL_UNAVAILABLE: configured model asset cannot be verified"); }
      if (actual !== asset.sha256) throw new Error("ANALYZER_MODEL_CHANGED: configured model asset digest changed");
    }
  }

  public async validateSource(input: AnalysisInput): Promise<void> {
    await this.verifyProviderIdentity();
    await verifyAnalyzerSource(input.media, "speech", this.options.timeoutMs ?? 120_000);
  }

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis> {
    await this.verifyProviderIdentity();
    const result = await runCommand<unknown>(this.options, { ...input, range }, "speech");
    await this.verifyProviderIdentity();
    try {
      if (this.options.requireVad) {
        requireStrictSpeechProvenance(result, input, range, this.descriptor);
      }
      const response = withCommandProvenance(result, this.descriptor);
      const raw = response as Record<string, unknown>;
      const analysis = bindSpeechAnalysis({ ...raw, coverageProvenance: raw?.observedRange === undefined ? "inferred" : "provider" }, { input, range, provider: this.descriptor });
      if (this.options.requireVad && analysis.capability !== "transcription-plus-vad") {
        throw new Error("ANALYZER_INVALID_OUTPUT: configured speech provider must return VAD evidence");
      }
      return analysis;
    } catch (error) {
      throw new Error(`ANALYZER_INVALID_OUTPUT: speech analyzer returned invalid JSON or schema: ${String(error)}`);
    }
  }
}

export class CommandAudioAnalyzer implements AudioAnalyzer {
  public readonly descriptor: AnalyzerDescriptor;

  public constructor(private readonly options: CommandAnalyzerOptions) {
    this.options = captureCommandOptions(options);
    this.descriptor = commandDescriptor(this.options, "audio");
  }

  public async validateSource(input: AnalysisInput): Promise<void> {
    await verifyAnalyzerSource(input.media, "audio", this.options.timeoutMs ?? 120_000);
  }

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis> {
    return withCommandProvenance(await runCommand<AudioAnalysis>(this.options, { ...input, range }, "audio"), this.descriptor);
  }
}

export class CommandVisualAnalyzer implements VisualAnalyzer {
  public readonly descriptor = { id: "command.visual", provider: "command" };

  public constructor(private readonly options: CommandAnalyzerOptions) {}

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<VisualAnalysis> {
    return runCommand<VisualAnalysis>(this.options, { ...input, range }, "visual");
  }
}

export class CommandMetadataAnalyzer implements MetadataAnalyzer {
  public readonly descriptor = { id: "command.metadata", provider: "command" };

  public constructor(private readonly options: CommandAnalyzerOptions) {}

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<MetadataAnalysis> {
    return runCommand<MetadataAnalysis>(this.options, { ...input, range }, "metadata");
  }
}

function captureCommandOptions(options: CommandAnalyzerOptions): CommandAnalyzerOptions {
  return { ...options, ...(options.modelAsset ? { modelAsset: { ...options.modelAsset } } : {}),
    ...(options.vadModelAsset ? { vadModelAsset: { ...options.vadModelAsset } } : {}), environment: { ...(options.environment ?? process.env) } };
}

function commandDescriptor(options: CommandAnalyzerOptions, kind: string): AnalyzerDescriptor {
  const environment = Object.entries(options.environment ?? {}).filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const configurationDigest = createHash("sha256").update(JSON.stringify({
    command: options.command, environment, requireVad: options.requireVad === true,
    providerVersion: options.providerVersion, modelIdentity: options.modelIdentity, modelAsset: options.modelAsset, vadModelAsset: options.vadModelAsset,
  })).digest("hex");
  return {
    id: `command.${kind}`, provider: "command",
    ...(options.providerVersion ? { version: options.providerVersion } : {}),
    ...(options.modelIdentity ? { model: options.modelIdentity } : {}),
    configurationDigest,
  };
}

function withCommandProvenance<T>(value: T, descriptor: AnalyzerDescriptor): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (result.provider === undefined) return { ...result, provider: structuredClone(descriptor) } as T;
  if (result.provider && typeof result.provider === "object" && !Array.isArray(result.provider)) {
    return { ...result, provider: { ...descriptor, ...result.provider } } as T;
  }
  return value;
}

async function runCommand<T>(options: CommandAnalyzerOptions, request: AnalyzerRequest, kind: string): Promise<T> {
  const source = request.media.source;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const initialDigest = await verifyAnalyzerSource(request.media, kind, timeoutMs);

  const child = spawn(options.command, [], { stdio: ["pipe", "pipe", "pipe"], env: options.environment });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;

  const result = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`ANALYZER_TIMEOUT: ${kind} analyzer exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ANALYZER_FAILED: ${kind} analyzer could not start: ${String(error)}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const diagnostic = stderr.length > 0 ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : "";
      if (code !== 0) {
        reject(new Error(`ANALYZER_FAILED: ${kind} analyzer exited with ${signal ?? `code ${code}`}${diagnostic}`));
        return;
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        validateResult(value, kind, request);
        resolve(value as T);
      } catch (error) {
        reject(new Error(`ANALYZER_INVALID_OUTPUT: ${kind} analyzer returned invalid JSON or schema: ${String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(commandRequest(request, kind)));
  });
  if (await digestAnalyzerSource(source, kind, timeoutMs) !== initialDigest) {
    throw new Error(`ANALYZER_SOURCE_CHANGED: ${kind} source bytes changed while analysis was running`);
  }
  return result;
}

async function verifyAnalyzerSource(media: AnalysisInput["media"], kind: string, timeoutMs: number): Promise<string> {
  const digest = await digestAnalyzerSource(media.source, kind, timeoutMs);
  const expectedDigest = media.sourceDigest?.replace(/^sha256:/, "");
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new Error(`ANALYZER_SOURCE_CHANGED: ${kind} source bytes do not match the requested source digest`);
  }
  return digest;
}

async function digestAnalyzerSource(source: string, kind: string, timeoutMs: number): Promise<string> {
  const stream = createReadStream(source);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const digest = createHash("sha256");
        for await (const chunk of stream) digest.update(chunk);
        return digest.digest("hex");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          stream.destroy();
          reject(new Error(`ANALYZER_TIMEOUT: ${kind} source verification exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch {
    if (timedOut) throw new Error(`ANALYZER_TIMEOUT: ${kind} source verification exceeded ${timeoutMs}ms`);
    throw new Error(`ANALYZER_MEDIA_UNAVAILABLE: ${kind} source cannot be read for content verification: ${source}`);
  } finally {
    if (timer) clearTimeout(timer);
    stream.destroy();
  }
}

function commandRequest(request: AnalyzerRequest, kind: string): unknown {
  if (kind !== "speech") return request;
  return {
    schemaVersion: 1,
    media: sourceIdentityOf(request.media),
    revision: request.project.revision,
    ...(request.range ? { range: structuredClone(request.range) } : {}),
  };
}

function sourceIdentityOf(media: AnalysisInput["media"]): MediaSourceIdentity {
  return {
    mediaId: media.mediaId,
    source: media.source,
    ...(media.sourceDigest ? { sourceDigest: media.sourceDigest } : {}),
    ...(media.mediaKind ? { mediaKind: media.mediaKind } : {}),
    ...(media.duration !== undefined ? { duration: media.duration } : {}),
  };
}

function requireStrictSpeechProvenance(
  value: unknown,
  input: AnalysisInput,
  range: TimeRange | undefined,
  provider: AnalyzerDescriptor,
): void {
  if (!value || typeof value !== "object") {
    throw new Error("ANALYZER_INVALID_OUTPUT: speech response must include complete trusted provenance");
  }
  const record = value as Record<string, unknown>;
  const required = ["schemaVersion", "mediaId", "sourceIdentity", "requestedRange", "revision", "provider"];
  const missing = required.filter((field) => record[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`ANALYZER_INVALID_OUTPUT: speech response is missing provenance: ${missing.join(", ")}`);
  }
  if (!sameAnalyzerDescriptor(record.provider, provider)) {
    throw new Error("ANALYZER_INVALID_OUTPUT: speech response provider provenance does not match the configured provider");
  }
  const sourceIdentity = sourceIdentityOf(input.media);
  if (record.mediaId !== sourceIdentity.mediaId
    || !sameMediaSourceIdentity(record.sourceIdentity as MediaSourceIdentity, sourceIdentity)) {
    throw new Error("ANALYZER_INVALID_OUTPUT: speech response source identity does not match the requested media");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("ANALYZER_INVALID_OUTPUT: speech response schema version is not supported");
  }
  const expectedRange = range ?? (input.media.duration === undefined ? undefined : { start: 0, end: input.media.duration });
  if (expectedRange && !sameRange(record.requestedRange, expectedRange)) {
    throw new Error("ANALYZER_INVALID_OUTPUT: speech response range does not match the runtime request");
  }
}

function sameAnalyzerDescriptor(value: unknown, expected: AnalyzerDescriptor): boolean {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  return descriptor.id === expected.id
    && descriptor.provider === expected.provider
    && descriptor.version === expected.version
    && (descriptor.model === undefined || descriptor.model === expected.model)
    && (descriptor.configurationDigest === undefined || descriptor.configurationDigest === expected.configurationDigest);
}

function sameRange(value: unknown, expected: TimeRange): boolean {
  if (!value || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  return range.start === expected.start && range.end === expected.end;
}

function validateResult(value: unknown, kind: string, request: AnalyzerRequest): void {
  if (!value || typeof value !== "object") throw new Error("result must be an object");
  const record = value as Record<string, unknown>;
  if (kind === "speech") {
    if (!Array.isArray(record.words) || record.words.some((word) => !isSpeechWord(word))) throw new Error("speech result requires typed words");
    return;
  }
  if (kind === "audio") {
    validateAudioAnalysisPayload(value);
    if (record.signalScope === "occurrence"
      && (!request.occurrenceId || record.occurrenceId !== request.occurrenceId)) {
      throw new Error("audio occurrence identity does not match the requested occurrence");
    }
    return;
  }
  if (kind === "metadata") {
    for (const key of ["subjects", "scenes", "environments", "timeOfDay", "moods"]) {
      if (record[key] !== undefined && (!Array.isArray(record[key]) || record[key].some((value) => !isSemanticTag(value)))) {
        throw new Error(`metadata ${key} must contain typed tags`);
      }
    }
    if (record.usableRanges !== undefined
      && (!Array.isArray(record.usableRanges) || record.usableRanges.some((value) => !isTimeRange(value)))) {
      throw new Error("metadata usableRanges must contain valid time ranges");
    }
    if (record.confidence !== undefined && !isFiniteNumber(record.confidence)) {
      throw new Error("metadata confidence must be numeric");
    }
    return;
  }
  if (!Array.isArray(record.scenes) || !Array.isArray(record.subjects) || !Array.isArray(record.keyframes)) {
    throw new Error("visual result requires scenes, subjects, and keyframes");
  }
}

function isSpeechWord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const word = value as Record<string, unknown>;
  return typeof word.text === "string"
    && typeof word.start === "number"
    && typeof word.end === "number"
    && typeof word.confidence === "number"
    && (word.filler === undefined || typeof word.filler === "boolean");
}

function isSemanticTag(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tag = value as Record<string, unknown>;
  return typeof tag.value === "string" && isFiniteNumber(tag.confidence);
}

function isTimeRange(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  return isFiniteNumber(range.start)
    && isFiniteNumber(range.end)
    && range.start >= 0
    && range.end > range.start
    && isOptionalRationalTime(range.startTime)
    && isOptionalRationalTime(range.durationTime);
}

function isOptionalRationalTime(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const time = value as Record<string, unknown>;
  return typeof time.value === "string" && typeof time.timescale === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
