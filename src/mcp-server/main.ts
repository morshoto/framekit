import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryEditorAdapter } from "../adapters/in-memory-editor.js";
import { createFinalCutLiveAdapter } from "../adapters/final-cut-live.js";
import { FixtureAudioAnalyzer, FixtureSpeechAnalyzer } from "../analyzers/fixture.js";
import { AgentVideoRuntime } from "../core/runtime.js";
import { createMcpServer } from "./server.js";

const fixture = new InMemoryEditorAdapter({
  projectId: "project-1",
  projectName: "Phase 0 Fixture",
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
  }],
});

const editor = process.env.PLAYHEAD_EDITOR === "final-cut-live"
  ? createFinalCutLiveAdapter()
  : fixture;

const runtime = new AgentVideoRuntime(editor, {
  speechAnalyzer: new FixtureSpeechAnalyzer(),
  audioAnalyzer: new FixtureAudioAnalyzer(),
});
const server = createMcpServer(runtime);
const transport = new StdioServerTransport();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`playhead MCP server shutting down (${signal})\n`);
  await transport.close();
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.once("end", () => void shutdown("stdin"));

await server.connect(transport);
