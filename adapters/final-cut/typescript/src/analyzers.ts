import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type {
  AnalysisInput,
  AudioAnalysis,
  AudioAnalyzer,
  MetadataAnalysis,
  MetadataAnalyzer,
  SpeechAnalysis,
  SpeechAnalyzer,
  TimeRange,
  VisualAnalysis,
  VisualAnalyzer,
} from "@framekit/runtime";

export interface CommandAnalyzerOptions {
  command: string;
  timeoutMs?: number;
}

interface AnalyzerRequest extends AnalysisInput {
  range?: TimeRange;
}

export function createCommandAnalyzers(options: {
  speechCommand?: string;
  audioCommand?: string;
  visualCommand?: string;
  metadataCommand?: string;
  timeoutMs?: number;
}): {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  metadataAnalyzer?: MetadataAnalyzer;
} {
  return {
    ...(options.speechCommand ? { speechAnalyzer: new CommandSpeechAnalyzer({ command: options.speechCommand, timeoutMs: options.timeoutMs }) } : {}),
    ...(options.audioCommand ? { audioAnalyzer: new CommandAudioAnalyzer({ command: options.audioCommand, timeoutMs: options.timeoutMs }) } : {}),
    ...(options.visualCommand ? { visualAnalyzer: new CommandVisualAnalyzer({ command: options.visualCommand, timeoutMs: options.timeoutMs }) } : {}),
    ...(options.metadataCommand ? { metadataAnalyzer: new CommandMetadataAnalyzer({ command: options.metadataCommand, timeoutMs: options.timeoutMs }) } : {}),
  };
}

export class CommandSpeechAnalyzer implements SpeechAnalyzer {
  public readonly descriptor = { id: "command.speech", provider: "command" };

  public constructor(private readonly options: CommandAnalyzerOptions) {}

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis> {
    return runCommand<SpeechAnalysis>(this.options, { ...input, range }, "speech");
  }
}

export class CommandAudioAnalyzer implements AudioAnalyzer {
  public readonly descriptor = { id: "command.audio", provider: "command" };

  public constructor(private readonly options: CommandAnalyzerOptions) {}

  public async analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis> {
    return runCommand<AudioAnalysis>(this.options, { ...input, range }, "audio");
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

async function runCommand<T>(options: CommandAnalyzerOptions, request: AnalyzerRequest, kind: string): Promise<T> {
  const source = request.media.source;
  try {
    await access(source);
  } catch {
    throw new Error(`ANALYZER_MEDIA_UNAVAILABLE: ${kind} source is not readable: ${source}`);
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const child = spawn(options.command, [], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;

  return new Promise<T>((resolve, reject) => {
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
        validateResult(value, kind);
        resolve(value as T);
      } catch (error) {
        reject(new Error(`ANALYZER_INVALID_OUTPUT: ${kind} analyzer returned invalid JSON or schema: ${String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

function validateResult(value: unknown, kind: string): void {
  if (!value || typeof value !== "object") throw new Error("result must be an object");
  const record = value as Record<string, unknown>;
  if (kind === "speech") {
    if (!Array.isArray(record.words) || record.words.some((word) => !isSpeechWord(word))) throw new Error("speech result requires typed words");
    return;
  }
  if (kind === "audio") {
    if (!["integratedLufs", "truePeakDb", "silenceMs"].every((key) => typeof record[key] === "number")) throw new Error("audio result requires loudness fields");
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
