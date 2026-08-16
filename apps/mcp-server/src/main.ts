import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createFinalCutLiveAdapter, FcpxmlDocumentAdapter, FinalCutSessionAdapter } from "@framekit/final-cut";
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

const editor = process.env.FRAMEKIT_EDITOR === "final-cut-live"
  ? new FinalCutSessionAdapter({
      live: createFinalCutLiveAdapter(),
      ...(process.env.FRAMEKIT_FCPXML_PATH
        ? (() => {
            const document = new FcpxmlDocumentAdapter(process.env.FRAMEKIT_FCPXML_PATH);
            return { snapshot: document, mutation: document };
          })()
        : {}),
    })
  : fixture;

const runtime = new AgentVideoRuntime(editor, {
  speechAnalyzer: new FixtureSpeechAnalyzer(),
  audioAnalyzer: new FixtureAudioAnalyzer(),
  visualAnalyzer: new FixtureVisualAnalyzer(),
});
const server = createMcpServer(runtime);
const transport = new StdioServerTransport();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`framekit MCP server shutting down (${signal})\n`);
  await transport.close();
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.once("end", () => void shutdown("stdin"));

await server.connect(transport);
