import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, type SpeechAnalyzer } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function runtimeWithSpeechCapabilities(capabilities: SpeechAnalyzer["capabilities"]) {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Speech capabilities",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{ mediaId: "media-1", source: "speech.wav", duration: 1 }],
  }), {
    speechAnalyzer: {
      capabilities,
      analyze: async () => ({ words: [] }),
    },
  });
}

test("editor inspection reports a configured transcription-only speech provider", async () => {
  const runtime = runtimeWithSpeechCapabilities({ transcription: true, vad: false });
  const inspected = await runtime.inspectEditor();

  assert.equal(inspected.capabilities.analyzers.speechTranscribe, true);
  assert.equal(inspected.capabilities.analyzers.speechVad, false);
  assert.equal(inspected.capabilities.analyzers.speechCapability, "transcription-only");
  assert.equal(inspected.capabilities.families.analyzers.speechTranscribe.available, true);
  assert.equal(inspected.capabilities.families.analyzers.speechVad.available, false);
});

test("editor inspection reports a configured transcription-plus-VAD provider", async () => {
  const runtime = runtimeWithSpeechCapabilities({ transcription: true, vad: true });
  const inspected = await runtime.inspectEditor();

  assert.equal(inspected.capabilities.analyzers.speechCapability, "transcription-plus-vad");
  assert.equal(inspected.capabilities.families.analyzers.speechVad.available, true);
});

test("editor inspection honors an explicit unavailable speech provider", async () => {
  const runtime = runtimeWithSpeechCapabilities({ transcription: false, vad: false });
  const inspected = await runtime.inspectEditor();

  assert.equal(inspected.capabilities.analyzers.speechTranscribe, false);
  assert.equal(inspected.capabilities.analyzers.speechVad, false);
  assert.equal(inspected.capabilities.analyzers.speechCapability, "unavailable");
});
