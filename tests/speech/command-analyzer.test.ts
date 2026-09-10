import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandSpeechAnalyzer } from "@framekit/final-cut";
import type { AnalysisInput } from "@framekit/runtime";

function createInput(mediaSource: string): AnalysisInput {
  return {
    project: {
      projectId: "project-1",
      projectName: "Command analyzer fixture",
      timeline: { id: "timeline-1", name: "Main", duration: 12, clips: [], storyElements: [], markers: [], captions: [] },
      media: [{ mediaId: "media-1", source: mediaSource, sourceDigest: "sha256:source", mediaKind: "audio", duration: 12 }],
      revision: { id: "rev-4", sequence: 4, timestamp: "2026-09-10T00:00:00.000Z" },
    },
    media: { mediaId: "media-1", source: mediaSource, sourceDigest: "sha256:source", mediaKind: "audio", duration: 12 },
  };
}

async function createWrapper(directory: string, output: unknown, capturePath?: string): Promise<string> {
  const wrapperPath = join(directory, "speech-wrapper.mjs");
  const capture = capturePath ? `await writeFile(${JSON.stringify(capturePath)}, JSON.stringify(request));` : "";
  await writeFile(wrapperPath, [
    "#!/usr/bin/env node",
    'import { readFile, writeFile } from "node:fs/promises";',
    'const request = JSON.parse(await readFile("/dev/stdin", "utf8"));',
    capture,
    `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`,
  ].filter(Boolean).join("\n"));
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

test("command speech analyzer sends a safe identity-bound request and returns VAD evidence", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-speech-wrapper-"));
  const mediaPath = join(directory, "interview.wav");
  const capturePath = join(directory, "request.json");
  await writeFile(mediaPath, "media");
  const wrapper = await createWrapper(directory, {
    words: [{ text: "hello", start: 2, end: 2.5, confidence: 0.98 }],
    vadSegments: [{ start: 2, end: 2.5, kind: "speech" }],
    sourceTimebase: { value: "1", timescale: "1000" },
  }, capturePath);
  const input = createInput(mediaPath);

  const result = await new CommandSpeechAnalyzer({ command: wrapper }).analyze(
    input,
    { start: 2, end: 6 },
  );
  const request = JSON.parse(await readFile(capturePath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(request, {
    schemaVersion: 1,
    media: input.media,
    revision: input.project.revision,
    range: { start: 2, end: 6 },
  });
  assert.equal(result.mediaId, "media-1");
  assert.deepEqual(result.sourceIdentity, input.media);
  assert.deepEqual(result.requestedRange, { start: 2, end: 6 });
  assert.deepEqual(result.observedRange, { start: 2, end: 6 });
  assert.deepEqual(result.revision, input.project.revision);
  assert.deepEqual(result.provider, { id: "command.speech", provider: "command" });
  assert.equal(result.capability, "transcription-plus-vad");
});

test("command speech analyzer keeps transcription-only output distinct", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-speech-transcription-"));
  const mediaPath = join(directory, "interview.wav");
  await writeFile(mediaPath, "media");
  const wrapper = await createWrapper(directory, {
    words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
  });

  const result = await new CommandSpeechAnalyzer({ command: wrapper }).analyze(createInput(mediaPath));

  assert.equal(result.capability, "transcription-only");
  assert.equal(result.vadSegments, undefined);
});

test("command speech analyzer fails closed for missing executables and malformed VAD", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-speech-errors-"));
  const mediaPath = join(directory, "interview.wav");
  await writeFile(mediaPath, "media");
  const input = createInput(mediaPath);
  const invalidWrapper = await createWrapper(directory, {
    words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
    vadSegments: [{ start: 0, end: 2, kind: "speech" }, { start: 1, end: 3, kind: "silence" }],
  });

  await assert.rejects(
    new CommandSpeechAnalyzer({ command: join(directory, "missing-wrapper") }).analyze(input),
    /ANALYZER_FAILED: speech analyzer could not start/,
  );
  await assert.rejects(
    new CommandSpeechAnalyzer({ command: invalidWrapper }).analyze(input),
    /ANALYZER_INVALID_OUTPUT: speech analyzer returned invalid JSON or schema/,
  );
});
