import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  createCommandAnalyzers,
  createFinalCutLiveAdapter,
  FcpxmlDocumentAdapter,
  FinalCutAssetRegistry,
  FinalCutConnectionManager,
  FinalCutNativeAutomationAdapter,
  FinalCutProjectPublisher,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import { FixtureAudioAnalyzer, FixtureSpeechAnalyzer, FixtureVisualAnalyzer } from "@framekit/testkit";
import { AgentVideoRuntime } from "@framekit/runtime";
import { createMcpServer } from "./server.js";

const fixture = new InMemoryEditorAdapter({
  projectId: "project-1",
  projectName: "Phase 2 Fixture",
  timelineId: "timeline-1",
  timelineName: "Main Edit",
  clips: [
    { id: "clip-1", mediaId: "media-1", name: "Interview", start: 0, duration: 10, track: 1 },
  ],
  media: [{
    mediaId: "media-1",
    source: "interview.wav",
    speech: { words: [{ text: "um", start: 0, end: 0.3, confidence: 0.98, filler: true }] },
    audio: { integratedLufs: -18, truePeakDb: -3, silenceMs: 120 },
    visual: {
      scenes: [{ id: "scene-1", start: 0, end: 10, label: "interview", confidence: 0.97 }],
      subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 0, end: 10 }],
      motion: { score: 0.12, label: "low" },
      keyframes: [{ time: 1, source: "interview.wav", labels: ["person", "interview"] }],
    },
  }],
  assets: [{
    id: "transition-cross-dissolve",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Framekit Fixture",
    metadata: { durationFrames: 12 },
  }],
});

const liveMode = process.env.FRAMEKIT_EDITOR === "final-cut-live";
const fcpxmlPath = liveMode ? process.env.FRAMEKIT_FCPXML_PATH : undefined;
const connection = liveMode ? new FinalCutConnectionManager() : undefined;
if (connection && process.env.FRAMEKIT_AUTO_CONNECT !== "0") connection.startAutoConnect();
const liveAdapter = liveMode ? createFinalCutLiveAdapter() : undefined;

const editor = liveMode
  ? new FinalCutSessionAdapter({
      live: liveAdapter!,
      ...(fcpxmlPath
        ? (() => {
            const document = new FcpxmlDocumentAdapter(fcpxmlPath);
            return { snapshot: document, mutation: document };
          })()
        : {}),
      assets: new FinalCutAssetRegistry({
        roots: process.env.FRAMEKIT_FINAL_CUT_ASSET_ROOTS
          ?.split(process.platform === "win32" ? ";" : ":")
          .map((root) => root.trim())
          .filter(Boolean),
      }),
    })
  : fixture;

const analyzers = liveMode
  ? createCommandAnalyzers({
      speechCommand: process.env.FRAMEKIT_SPEECH_ANALYZER,
      audioCommand: process.env.FRAMEKIT_AUDIO_ANALYZER,
      visualCommand: process.env.FRAMEKIT_VISUAL_ANALYZER,
      timeoutMs: parseTimeout(process.env.FRAMEKIT_ANALYZER_TIMEOUT_MS),
    })
  : {
      speechAnalyzer: new FixtureSpeechAnalyzer(),
      audioAnalyzer: new FixtureAudioAnalyzer(),
      visualAnalyzer: new FixtureVisualAnalyzer(),
    };

const runtime = new AgentVideoRuntime(editor, analyzers);
const nativeEditor = liveMode
  ? new FinalCutNativeAutomationAdapter({ liveState: () => liveAdapter!.readLiveState() })
  : undefined;
const projectPublisher = liveMode && fcpxmlPath && process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES === "1"
  ? new FinalCutProjectPublisher({
      enabled: true,
      sourcePath: fcpxmlPath,
      liveState: () => liveAdapter!.readLiveState(),
    })
  : undefined;
const server = createMcpServer(runtime, {
  connectionStatus: () => connection?.getStatus(),
  nativeEditor,
  projectPublisher,
});
const transport = new StdioServerTransport();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  connection?.stopAutoConnect();
  process.stderr.write(`framekit MCP server shutting down (${signal})\n`);
  await transport.close();
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.once("end", () => void shutdown("stdin"));

await server.connect(transport);

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}
