import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCommandAnalyzers } from "@framekit/final-cut";
import { AgentVideoRuntime, type AnalyzerDescriptor, type AudioAnalysis, type AudioAnalyzer, type RationalTime, type RevisionBoundSpeechAnalysis, type SpeechAnalyzer, type TimeRange } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../apps/mcp-server/src/server.js";

interface CapabilityResult {
  status: "available" | "unavailable";
  reason?: string;
}

interface SpeechResult extends CapabilityResult {
  provider?: AnalyzerDescriptor;
  capability?: RevisionBoundSpeechAnalysis["capability"];
  transcript?: string;
  expectedTokensMatched?: boolean;
  sourceTimebase?: RationalTime;
  requestedRange?: TimeRange;
  observedRange?: TimeRange;
}

interface AudioResult extends CapabilityResult {
  provider?: AnalyzerDescriptor;
  signalScope?: AudioAnalysis["signalScope"];
  sourceTimebase?: RationalTime;
  signalFormat?: AudioAnalysis["signalFormat"];
  measuredRange?: TimeRange;
  analyzedDurationSeconds?: number;
  integratedLufs?: number;
  truePeakDb?: number;
  silenceMs?: number;
}

export interface AnalysisProviderPreflight {
  schemaVersion: 1;
  evidence: "headless-command-provider";
  nativeAcceptance: "not-run";
  status: "ready" | "blocked";
  sourceIntegrity: "unchanged";
  fixtureSpecDigest: string;
  assets: Array<{
    filename: string;
    sourceDigest: string;
    requestedRange: TimeRange;
    speech: SpeechResult;
    vad: CapabilityResult & { segmentCount?: number };
    audio: AudioResult;
  }>;
}

export async function runAnalysisProviderPreflight(options: {
  fixtures: string;
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
}): Promise<AnalysisProviderPreflight> {
  const specBytes = await readFile(new URL("../tests/fixtures/codex-video-speech/fixture-spec.json", import.meta.url));
  const spec = JSON.parse(specBytes.toString()) as { clips: Array<{
    id: string; filename: string; durationSeconds: number; requestedRange: [number, number]; expectedTokens: string[];
  }> };
  const manifest = JSON.parse(await readFile(join(options.fixtures, "fixture-manifest.json"), "utf8")) as {
    assets: Array<{ filename: string; sha256: string }>;
  };
  const sources = await Promise.all(spec.clips.map(async (clip) => {
    const source = join(resolve(options.fixtures), clip.filename);
    const expected = manifest.assets.find((asset) => asset.filename === clip.filename)?.sha256;
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || await digest(source) !== expected) {
      throw new Error("PREFLIGHT_SOURCE_CHANGED: fixture content does not match its recorded digest");
    }
    return { clip, source, expected };
  }));
  const adapter = new InMemoryEditorAdapter({
    projectId: "analysis-provider-preflight", projectName: "Synthetic provider preflight",
    timelineId: "fixture", timelineName: "No native timeline", clips: [],
    media: sources.map(({ clip, source, expected }) => ({
      mediaId: "preflight-" + clip.id, source, sourceDigest: expected, mediaKind: "video", duration: clip.durationSeconds,
    })),
  });
  const before = await adapter.readProject();
  const runtime = new AgentVideoRuntime(adapter, options);
  const server = createMcpServer(runtime);
  const client = new Client({ name: "analysis-provider-preflight", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const assets: AnalysisProviderPreflight["assets"] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const { clip, expected } of sources) {
      const range = { start: clip.requestedRange[0], end: clip.requestedRange[1] };
      const args = { mediaId: "preflight-" + clip.id, range };
      let speech: SpeechResult = unavailable(options.speechAnalyzer ? "provider-version-unpinned" : "provider-unconfigured");
      let vad: CapabilityResult & { segmentCount?: number } = unavailable("speech-unavailable");
      if (options.speechAnalyzer?.descriptor?.version?.trim()) {
        const result = await analyze<RevisionBoundSpeechAnalysis>(client, "speech.analyze", args);
        if (result.value) {
          const value = result.value;
          const tokens = value.words.flatMap(({ text }) => text.toLowerCase().match(/[a-z]+/g) ?? []);
          speech = {
            status: "available", provider: value.provider, capability: value.capability,
            transcript: value.words.map(({ text }) => text).join(" "),
            expectedTokensMatched: clip.expectedTokens.every((token) => tokens.includes(token)),
            sourceTimebase: value.sourceTimebase, requestedRange: value.requestedRange, observedRange: value.observedRange,
          };
          const segments = value.vadSegments?.filter((segment) => segment.kind === "speech") ?? [];
          vad = value.capability === "transcription-plus-vad" && segments.length > 0
            ? { status: "available", segmentCount: segments.length } : unavailable("required-vad-unavailable");
        } else speech = unavailable(result.reason!);
      }
      let audio: AudioResult = unavailable(options.audioAnalyzer ? "provider-version-unpinned" : "provider-unconfigured");
      if (options.audioAnalyzer?.descriptor?.version?.trim()) {
        const result = await analyze<AudioAnalysis>(client, "audio.analyze", args);
        audio = result.value && result.value.valid !== false ? {
          status: "available", provider: result.value.provider, signalScope: result.value.signalScope,
          sourceTimebase: result.value.sourceTimebase, signalFormat: result.value.signalFormat,
          measuredRange: result.value.measuredRange, analyzedDurationSeconds: result.value.analyzedDurationSeconds,
          integratedLufs: result.value.integratedLufs, truePeakDb: result.value.truePeakDb, silenceMs: result.value.silenceMs,
        } : unavailable(result.reason ?? "provider-rejected-audio");
      }
      assets.push({ filename: clip.filename, sourceDigest: expected, requestedRange: range, speech, vad, audio });
    }
  } finally {
    await client.close();
    await server.close();
  }
  if (JSON.stringify(await adapter.readProject()) !== JSON.stringify(before)) {
    throw new Error("PREFLIGHT_TIMELINE_CHANGED: analysis modified the headless fixture snapshot");
  }
  for (const { source, expected } of sources) {
    if (await digest(source) !== expected) throw new Error("PREFLIGHT_SOURCE_CHANGED: analysis modified fixture content");
  }
  return {
    schemaVersion: 1, evidence: "headless-command-provider", nativeAcceptance: "not-run",
    status: assets.every((asset) => asset.speech.status === "available" && asset.speech.expectedTokensMatched
      && asset.vad.status === "available" && asset.audio.status === "available") ? "ready" : "blocked",
    sourceIntegrity: "unchanged", fixtureSpecDigest: createHash("sha256").update(specBytes).digest("hex"), assets,
  };
}

function unavailable(reason: string): CapabilityResult { return { status: "unavailable", reason }; }
async function digest(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }

async function analyze<T>(client: Client, name: string, args: { mediaId: string; range: TimeRange }): Promise<{ value?: T; reason?: string }> {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as Array<{ text?: string }>)[0]?.text ?? "";
  if (response.isError) return { reason: text.match(/\b[A-Z][A-Z0-9_]{3,}\b/)?.[0] ?? "provider-failed" };
  return { value: JSON.parse(text) as T };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--fixtures" || args[2] !== "--output") {
      throw new Error("usage: run-analysis-provider-preflight.ts --fixtures <generated-directory> --output <report.json>");
    }
    const providers = createCommandAnalyzers({
      speechCommand: process.env.FRAMEKIT_SPEECH_ANALYZER,
      speechProviderVersion: process.env.FRAMEKIT_SPEECH_ANALYZER_VERSION,
      audioCommand: process.env.FRAMEKIT_AUDIO_ANALYZER,
      audioProviderVersion: process.env.FRAMEKIT_AUDIO_ANALYZER_VERSION,
      timeoutMs: Number(process.env.FRAMEKIT_ANALYZER_TIMEOUT_MS ?? 120000),
    });
    const report = await runAnalysisProviderPreflight({ fixtures: args[1]!, ...providers });
    await writeFile(args[3]!, JSON.stringify({ ...report, executedHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ status: report.status, nativeAcceptance: report.nativeAcceptance }) + "\n");
    process.exitCode = report.status === "ready" ? 0 : 2;
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
