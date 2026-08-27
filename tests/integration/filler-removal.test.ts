import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, planFillerRemoval, type SpeechAnalyzer } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createFillerRuntime(analyzer: SpeechAnalyzer) {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-filler",
    projectName: "Filler Fixture",
    timelineId: "timeline-filler",
    timelineName: "Main Edit",
    clips: [{ id: "clip-filler", mediaId: "media-filler", name: "Interview", start: 10, duration: 3, track: 0 }],
    media: [{
      mediaId: "media-filler",
      source: "interview.wav",
      speech: {
        words: [
          { text: "So", start: 0, end: 0.3, confidence: 0.99 },
          { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
          { text: "what", start: 1.6, end: 2, confidence: 0.99 },
        ],
      },
    }],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter, { speechAnalyzer: analyzer }) };
}

test("filler planning selects high-confidence words and preserves a short pause", () => {
  const candidates = planFillerRemoval([
    { text: "So", start: 0, end: 0.3, confidence: 0.99 },
    { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    { text: "what", start: 1.6, end: 2, confidence: 0.99 },
    { text: "well", start: 2.2, end: 2.5, confidence: 0.7, filler: true },
  ], { start: 0, end: 2.5 });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    word: { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    range: {
      start: 0.4,
      end: 1.1,
      startTime: { value: "2", timescale: "5" },
      durationTime: { value: "7", timescale: "10" },
    },
  });
});

test("filler planning removes only the word when adjacent speech boundaries are uncertain", () => {
  const candidates = planFillerRemoval([
    { text: "hello", start: 0, end: 1, confidence: 0.99 },
    { text: "um", start: 1.1, end: 1.3, confidence: 0.98, filler: true },
    { text: "world", start: 1.5, end: 2, confidence: 0.99 },
  ], { start: 0, end: 2 });

  assert.deepEqual(candidates[0]?.range, {
    start: 1.1,
    end: 1.3,
    startTime: { value: "11", timescale: "10" },
    durationTime: { value: "1", timescale: "5" },
  });
});

test("filler planning returns multiple ranges from latest to earliest", () => {
  const candidates = planFillerRemoval([
    { text: "um", start: 0.4, end: 0.7, confidence: 0.98, filler: true },
    { text: "then", start: 0.8, end: 1.1, confidence: 0.99 },
    { text: "uh", start: 1.2, end: 1.4, confidence: 0.97, filler: true },
  ], { start: 0, end: 2 });

  assert.deepEqual(candidates.map(({ range }) => range.start), [1.2, 0.4]);
});

test("filler planning rejects malformed speech boundaries", () => {
  assert.throws(
    () => planFillerRemoval([
      { text: "um", start: 1, end: 0.5, confidence: 0.98, filler: true },
    ], { start: 0, end: 2 }),
    /ANALYSIS_INVALID: speech word boundaries/,
  );
});

test("filler preview maps media speech to a guarded timeline delete", async () => {
  const analyzer: SpeechAnalyzer = { analyze: async ({ media }) => structuredClone(media.speech!) };
  const { adapter, runtime } = createFillerRuntime(analyzer);
  const before = await runtime.inspectProject();

  const preview = await runtime.previewFillerRemoval({
    baseRevision: before.revision,
    range: { start: 10, end: 13 },
  });

  assert.match(preview.previewToken, /^filler-preview-/);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0]?.clipId, "clip-filler");
  assert.equal(preview.candidates[0]?.mediaId, "media-filler");
  assert.deepEqual(preview.operations, [{
    type: "ripple-delete",
    timelineId: "timeline-filler",
    range: {
      start: 10.4,
      end: 11.1,
      startTime: { value: "52", timescale: "5" },
      durationTime: { value: "7", timescale: "10" },
    },
    reason: "remove high-confidence filler word: um",
  }]);
  assert.ok(Math.abs((preview.expectedDiff?.durationDelta ?? 0) + 0.7) < 0.000001);
  assert.deepEqual(await adapter.readProject(), before);
});

test("filler execution reanalyzes continuity and returns a reversible verified transaction", async () => {
  let calls = 0;
  const analyzer: SpeechAnalyzer = {
    analyze: async ({ media }) => {
      calls += 1;
      if (calls === 1) return structuredClone(media.speech!);
      return { words: [
        { text: "So", start: 0, end: 0.3, confidence: 0.99 },
        { text: "what", start: 0.9, end: 1.3, confidence: 0.99 },
      ] };
    },
  };
  const { runtime } = createFillerRuntime(analyzer);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewFillerRemoval({ baseRevision: before.revision, range: { start: 10, end: 13 } });

  const transaction = await runtime.executeFillerRemoval(preview.previewToken);

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.intent, "remove-filler-words");
  assert.equal(transaction.applied.length, 1);
  assert.ok(Math.abs(transaction.diff.durationDelta + 0.7) < 0.000001);
  assert.ok(Math.abs((transaction.after.timeline.clips[0]?.duration ?? 0) - 2.3) < 0.000001);
  assert.equal(transaction.after.media[0]?.speech?.words.some((word) => word.filler), false);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "filler-speech-continuity" && check.passed), true);
  assert.equal(calls, 2);

  const restored = await runtime.undo(transaction.id);
  assert.equal(restored.timeline.clips[0]?.duration, 3);
});

test("failed filler continuity verification restores the original timeline", async () => {
  const analyzer: SpeechAnalyzer = { analyze: async ({ media }) => structuredClone(media.speech!) };
  const { runtime } = createFillerRuntime(analyzer);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewFillerRemoval({ baseRevision: before.revision, range: { start: 10, end: 13 } });

  const transaction = await runtime.executeFillerRemoval(preview.previewToken);

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.passed, false);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "filler-speech-continuity" && !check.passed), true);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]?.duration, 3);
});

test("filler removal requires canonical timeline writes and never falls back to artifact mutation", async () => {
  const analyzer: SpeechAnalyzer = { analyze: async ({ media }) => structuredClone(media.speech!) };
  const { adapter, runtime } = createFillerRuntime(analyzer);
  const originalCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => ({
    ...await originalCapabilities(),
    editor: {
      ...(await originalCapabilities()).editor,
      timelineWrite: false,
      timelineArtifactWrite: true,
    },
  });
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewFillerRemoval({ baseRevision: before.revision, range: { start: 10, end: 13 } }),
    /CAPABILITY_UNAVAILABLE: filler removal requires canonical timeline write/,
  );
  assert.equal((await adapter.readProject()).revision.id, before.revision.id);
});
