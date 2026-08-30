import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createRuntime(audio: { integratedLufs: number; truePeakDb: number; silenceMs: number; audibleSamples?: number }) {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "verification-project",
    projectName: "Verification Fixture",
    timelineId: "verification-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "rain-clip", mediaId: "rain", name: "Rain", start: 0, duration: 10, track: -1 }],
    media: [{
      mediaId: "rain",
      source: "rain.wav",
      mediaKind: "audio",
      duration: 10,
      sourceDigest: "sha256:rain",
      audio,
    }],
  }));
}

test("semantic audio audibility rejects silent audio with an audio stream", async () => {
  const runtime = createRuntime({
    integratedLufs: -80,
    truePeakDb: -80,
    silenceMs: 10_000,
    audibleSamples: 0,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-audibility");
  assert.deepEqual(check, {
    name: "audio-audibility",
    passed: false,
    status: "failed",
    expected: { mediaId: "rain", minAudibleSamples: 1 },
    observed: { mediaId: "rain", audibleSamples: 0, silenceMs: 10_000 },
    reason: "AUDIO_NOT_AUDIBLE",
    detail: "expected audible audio samples, observed none",
  });
});

test("semantic audio assertions verify coverage, loudness, and source identity", async () => {
  const runtime = createRuntime({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 120,
    audibleSamples: 1_000,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [
        { type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 },
        { type: "audio-coverage", mediaId: "rain", start: 0, duration: 10 },
        { type: "audio-loudness", mediaId: "rain", targetLufs: -18, toleranceDb: 0.5 },
        { type: "audio-source", mediaId: "rain", sourceDigest: "sha256:rain" },
      ],
    } as never,
  );

  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    transaction.verification?.checks
      .filter((check) => ["audio-audibility", "audio-coverage", "audio-loudness", "audio-source"].includes(check.name))
      .map((check) => check.name),
    ["audio-audibility", "audio-coverage", "audio-loudness", "audio-source"],
  );
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-loudness")?.observed, -18);
});

test("semantic audio coverage rejects an ambience shorter than requested", async () => {
  const runtime = createRuntime({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 120,
    audibleSamples: 1_000,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-coverage", mediaId: "rain", start: 0, duration: 11 }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-coverage");
  assert.equal(check?.reason, "AUDIO_COVERAGE_INCOMPLETE");
  assert.deepEqual(check?.expected, { mediaId: "rain", start: 0, duration: 11, toleranceSeconds: 0 });
});
