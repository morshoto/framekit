import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandSpeechAnalyzer } from "@framekit/final-cut";
import { AgentVideoRuntime, type SpeechAnalyzer } from "@framekit/runtime";
import { FixtureSpeechAnalyzer, InMemoryEditorAdapter } from "@framekit/testkit";

const words = [
  { text: "hello", start: 0, end: 1, confidence: 0.98 },
  { text: "world", start: 2, end: 3, confidence: 0.97 },
];
const vadSegments = [
  { start: 0, end: 1, kind: "speech" as const },
  { start: 1, end: 2, kind: "silence" as const },
  { start: 2, end: 3, kind: "speech" as const },
];

test("fixture and configured speech providers satisfy the shared contract", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-speech-conformance-"));
  const mediaPath = join(directory, "interview.wav");
  await writeFile(mediaPath, "fixture media");
  const command = join(directory, "speech-wrapper.mjs");
  await writeFile(command, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(JSON.stringify({ words, vadSegments, sourceTimebase: { value: "1", timescale: "1000" } }))});`,
  ].join("\n"));
  await chmod(command, 0o755);

  const providers: Array<[string, () => SpeechAnalyzer, string]> = [
    ["fixture", () => new FixtureSpeechAnalyzer(), "fixture.speech"],
    ["command", () => new CommandSpeechAnalyzer({ command }), "command.speech"],
  ];
  for (const [name, createAnalyzer, providerId] of providers) {
    const adapter = new InMemoryEditorAdapter({
      projectId: "project-speech-conformance",
      projectName: "Speech Conformance",
      timelineId: "timeline-speech-conformance",
      timelineName: "Main",
      clips: [],
      media: [{
        mediaId: "media-speech-conformance",
        source: mediaPath,
        mediaKind: "audio",
        duration: 6,
        speech: { words, vadSegments },
      }],
    });
    const runtime = new AgentVideoRuntime(adapter, { speechAnalyzer: createAnalyzer() });
    const result = await runtime.analyzeSpeech("media-speech-conformance");

    assert.equal(result.mediaId, "media-speech-conformance", name);
    assert.ok(result.provider, name);
    assert.equal(result.provider.id, providerId, name);
    assert.deepEqual(result.sourceIdentity, {
      mediaId: "media-speech-conformance",
      source: mediaPath,
      mediaKind: "audio",
      duration: 6,
    }, name);
    assert.deepEqual(result.revision, (await adapter.readProject()).revision, name);
    assert.deepEqual(result.requestedRange, { start: 0, end: 6 }, name);
    assert.deepEqual(result.observedRange, { start: 0, end: 6 }, name);
    assert.deepEqual(result.sourceTimebase, { value: "1", timescale: "1000" }, name);
    assert.equal(result.capability, "transcription-plus-vad", name);
    assert.deepEqual(result.words, words, name);
    assert.deepEqual(result.vadSegments, vadSegments, name);
  }
});
