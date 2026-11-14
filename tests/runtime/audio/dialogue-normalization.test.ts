import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type AudioAnalyzer,
  type RuntimeOptions,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

const policy = {
  targetLufs: -16,
  toleranceDb: 0.5,
  maxTruePeakDb: -1,
  minGainDb: -6,
  maxGainDb: 6,
  minDialogueDurationSeconds: 1,
};

function createDialogueRuntime(
  audio: Partial<{ integratedLufs: number; truePeakDb: number; silenceMs: number; dialoguePresent: boolean }> = {},
  options: RuntimeOptions = {},
) {
  const adapter = new InMemoryEditorAdapter({
    projectId: "dialogue-project",
    projectName: "Dialogue Fixture",
    timelineId: "dialogue-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "dialogue-clip", mediaId: "dialogue-media", name: "Dialogue", start: 0, duration: 10, track: 1 }],
    media: [{
      mediaId: "dialogue-media",
      source: "fixtures/dialogue.wav",
      mediaKind: "video",
      duration: 10,
      sourceDigest: "sha256:dialogue",
      speech: { words: [{ text: "hello", start: 0, end: 2, confidence: 0.99 }] },
    }],
  });
  let audioAnalysisCalls = 0;
  const analyzer: AudioAnalyzer = {
    descriptor: { id: "fixture.dialogue-audio", provider: "fixture", version: "1" },
    analyze: async ({ project }) => {
      audioAnalysisCalls += 1;
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-clip")?.gainDb ?? 0;
      return {
        integratedLufs: (audio.integratedLufs ?? -20) + gain,
        truePeakDb: (audio.truePeakDb ?? -6) + gain,
        silenceMs: audio.silenceMs ?? 100,
        analyzedDurationSeconds: 10,
        dialoguePresent: audio.dialoguePresent ?? true,
      };
    },
  };
  return {
    adapter,
    runtime: new AgentVideoRuntime(adapter, { audioAnalyzer: analyzer, ...options }),
    audioAnalysisCalls: () => audioAnalysisCalls,
  };
}

test("dialogue preview reports measurement, decision, gain, and does not mutate", async () => {
  const { adapter, runtime } = createDialogueRuntime();
  const before = await runtime.inspectProject();

  const preview = await runtime.previewDialogueNormalization({
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-clip",
    baseRevision: before.revision,
    ...policy,
  });

  assert.equal(preview.plan.decision, "APPLY");
  assert.equal(preview.plan.currentLufs, -20);
  assert.equal(preview.plan.clampedGainDb, 4);
  assert.equal(preview.measurement.occurrenceId, "dialogue-clip");
  assert.equal(preview.measurement.revision.id, before.revision.id);
  assert.deepEqual(preview.operations, [{
    type: "set-gain",
    clipId: "dialogue-clip",
    gainDb: 4,
    baseRevision: before.revision,
  }]);
  assert.deepEqual(await adapter.readProject(), before);
});

test("dialogue execution re-measures the occurrence and returns a verified transaction", async () => {
  const { runtime } = createDialogueRuntime();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewDialogueNormalization({
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-clip",
    baseRevision: before.revision,
    ...policy,
  });

  const transaction = await runtime.executeDialogueNormalization(preview.previewToken!);

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.after.timeline.clips[0]?.gainDb, 4);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "dialogue-loudness" && check.passed), true);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "dialogue-true-peak" && check.passed), true);
});

test("dialogue NO_OP and SKIP previews never issue an edit token", async () => {
  const normalized = createDialogueRuntime({ integratedLufs: -16, truePeakDb: -3 });
  const normalizedBefore = await normalized.runtime.inspectProject();
  const noOp = await normalized.runtime.previewDialogueNormalization({
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-clip",
    baseRevision: normalizedBefore.revision,
    ...policy,
  });
  assert.equal(noOp.plan.decision, "NO_OP");
  assert.equal(noOp.previewToken, undefined);
  assert.equal(canonicalSnapshotDigest(await normalized.adapter.readProject()), canonicalSnapshotDigest(normalizedBefore));

  const silent = createDialogueRuntime({ silenceMs: 10_000 });
  const silentBefore = await silent.runtime.inspectProject();
  const skipped = await silent.runtime.previewDialogueNormalization({
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-clip",
    baseRevision: silentBefore.revision,
    ...policy,
  });
  assert.equal(skipped.plan.decision, "SKIP");
  assert.equal(skipped.plan.reasonCodes[0], "SILENCE");
  assert.equal(skipped.previewToken, undefined);
  assert.equal(canonicalSnapshotDigest(await silent.adapter.readProject()), canonicalSnapshotDigest(silentBefore));
});

test("dialogue preview fails closed before analysis when canonical writes are unavailable", async () => {
  const { adapter, runtime, audioAnalysisCalls } = createDialogueRuntime();
  const before = await runtime.inspectProject();
  const getCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => {
    const capabilities = await getCapabilities();
    return {
      ...capabilities,
      editor: { ...capabilities.editor, timelineWrite: false },
    };
  };

  await assert.rejects(
    runtime.previewDialogueNormalization({
      mediaId: "dialogue-media",
      occurrenceId: "dialogue-clip",
      baseRevision: before.revision,
      ...policy,
    }),
    /CAPABILITY_UNAVAILABLE: dialogue normalization requires canonical timeline write, read-after-write, and rollback/,
  );
  assert.equal(audioAnalysisCalls(), 0);
  assert.deepEqual(await adapter.readProject(), before);
});

test("failed dialogue verification rolls back the complete transaction", async () => {
  const { adapter, runtime } = createDialogueRuntime({}, {
    verificationEngine: {
      verify: async () => ({
        passed: false,
        checks: [{ name: "controlled-dialogue-failure", passed: false, detail: "controlled rollback fixture" }],
      }),
    },
  });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewDialogueNormalization({
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-clip",
    baseRevision: before.revision,
    ...policy,
  });

  const transaction = await runtime.executeDialogueNormalization(preview.previewToken!);

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});
