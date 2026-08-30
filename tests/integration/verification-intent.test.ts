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
