import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type AudioAnalyzer,
} from "@framekit/runtime";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { InMemoryEditorAdapter } from "@framekit/testkit";

const defaults = {
  targetLufs: -16,
  toleranceDb: 0.5,
  maxTruePeakDb: -1,
  minGainDb: -6,
  maxGainDb: 6,
  minDialogueDurationSeconds: 1,
};

function createFixture(options: {
  integratedLufs?: number;
  truePeakDb?: number;
  silenceMs?: number;
  dialoguePresent?: boolean;
  analyzedDurationSeconds?: number;
  sourceStart?: number;
  duration?: number;
  clips?: Array<{ id: string; mediaId: string; start: number; duration: number; sourceStart?: number }>;
  analyze?: AudioAnalyzer["analyze"];
} = {}) {
  const clips = options.clips ?? [{
    id: "dialogue-occurrence",
    mediaId: "dialogue-media",
    start: 0,
    duration: options.duration ?? 10,
    ...(options.sourceStart === undefined ? {} : { sourceStart: options.sourceStart }),
  }];
  const adapter = new InMemoryEditorAdapter({
    projectId: "dialogue-skill-project",
    projectName: "Dialogue Skill",
    timelineId: "dialogue-skill-timeline",
    timelineName: "Main Edit",
    clips: clips.map((clip, index) => ({ ...clip, name: `Dialogue ${index + 1}`, track: 1 })),
    media: [{
      mediaId: "dialogue-media",
      source: "fixtures/dialogue.wav",
      mediaKind: "video",
      duration: 20,
      speech: { words: [{ text: "hello", start: 0, end: 2, confidence: 0.99 }] },
    }],
  });
  const analyzer: AudioAnalyzer = {
    descriptor: { id: "fixture.dialogue", provider: "fixture", version: "1" },
    analyze: options.analyze ?? (async ({ project }) => {
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-occurrence")?.gainDb ?? 0;
      return {
        integratedLufs: (options.integratedLufs ?? -20) + gain,
        truePeakDb: (options.truePeakDb ?? -6) + gain,
        silenceMs: options.silenceMs ?? 100,
        analyzedDurationSeconds: options.analyzedDurationSeconds ?? 10,
        dialoguePresent: options.dialoguePresent ?? true,
      };
    }),
  };
  return { adapter, analyzer, runtime: new AgentVideoRuntime(adapter, { audioAnalyzer: analyzer }) };
}

async function previewDialogue(runtime: AgentVideoRuntime, input: Record<string, unknown> = {}) {
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "dialogue-normalization",
    baseRevision: before.revision,
    input: {
      mediaId: "dialogue-media",
      occurrenceId: "dialogue-occurrence",
      ...input,
    },
  });
  return { before, preview };
}

test("dialogue Skill exposes versioned defaults and composite capability", async () => {
  const { runtime } = createFixture();
  runtime.registerBuiltinSkills();

  const manifest = runtime.inspectSkill("dialogue-normalization");
  assert.deepEqual(manifest.defaults, defaults);
  assert.match(JSON.stringify(manifest.requirements), /compositeTransactions/);

  const { adapter, runtime: unavailableRuntime } = createFixture();
  const getCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => {
    const capabilities = await getCapabilities();
    return { ...capabilities, editor: { ...capabilities.editor, compositeTransactions: false } };
  };
  unavailableRuntime.registerBuiltinSkills();
  const inspection = await unavailableRuntime.inspectSkillAvailability("dialogue-normalization");
  assert.equal(inspection.availability.available, false);
  assert.ok(inspection.availability.missingRequirements.some((item) => item.name === "compositeTransactions"));
});

test("dialogue preview resolves defaults and targets one complete occurrence range", async () => {
  const ranges: Array<{ start: number; end: number } | undefined> = [];
  const { runtime, analyzer, adapter } = createFixture({
    sourceStart: 5,
    duration: 3,
    analyze: async ({ project }, range) => {
      ranges.push(range);
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-occurrence")?.gainDb ?? 0;
      return {
        integratedLufs: -20 + gain,
        truePeakDb: -6 + gain,
        silenceMs: 100,
        analyzedDurationSeconds: 3,
        dialoguePresent: true,
      };
    },
  });
  runtime.registerBuiltinSkills();

  const { before, preview } = await previewDialogue(runtime);

  assert.deepEqual(preview.plan.normalizedInput, {
    mediaId: "dialogue-media",
    occurrenceId: "dialogue-occurrence",
    ...defaults,
  });
  assert.equal(preview.plan.decision, "APPLY");
  assert.equal(preview.plan.details?.occurrenceId, "dialogue-occurrence");
  assert.equal(preview.plan.details?.currentLufs, -20);
  assert.equal(preview.plan.details?.truePeakDb, -6);
  assert.equal(preview.plan.details?.targetLufs, -16);
  assert.equal(preview.plan.details?.toleranceDb, 0.5);
  assert.equal(preview.plan.details?.clampedGainDb, 4);
  assert.equal(preview.plan.details?.estimatedPeakDb, -2);
  assert.equal(preview.plan.operations[0]?.type, "set-gain");
  assert.equal(preview.plan.operations[0]?.type === "set-gain" ? preview.plan.operations[0].clipId : undefined, "dialogue-occurrence");
  assert.deepEqual(ranges, [{ start: 5, end: 8 }]);
  assert.equal(preview.previewToken.startsWith("skill-preview-"), true);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
  assert.equal(analyzer.descriptor?.provider, "fixture");
});

test("already-normalized dialogue executes as a verified no-op", async () => {
  const { runtime, adapter } = createFixture({ integratedLufs: -16, truePeakDb: -3 });
  runtime.registerBuiltinSkills();
  const { before, preview } = await previewDialogue(runtime);

  assert.equal(preview.plan.decision, "NO_OP");
  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(result.transactionIds, []);
  assert.equal(result.rollback.attempted, false);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("dialogue execution remeasures after writing and verifies the new result", async () => {
  let calls = 0;
  const { runtime, adapter } = createFixture({
    analyze: async ({ project }) => {
      calls += 1;
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-occurrence")?.gainDb ?? 0;
      return {
        integratedLufs: calls === 1 ? -20 : -19,
        truePeakDb: -6 + gain,
        silenceMs: 100,
        analyzedDurationSeconds: 10,
        dialoguePresent: true,
      };
    },
  });
  runtime.registerBuiltinSkills();
  const { before, preview } = await previewDialogue(runtime);

  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(calls, 2);
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.rollback.succeeded, true);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("dialogue Skill targets the selected occurrence when media is repeated", async () => {
  const ranges: Array<{ start: number; end: number } | undefined> = [];
  const { runtime } = createFixture({
    clips: [
      { id: "dialogue-first", mediaId: "dialogue-media", start: 0, duration: 4, sourceStart: 0 },
      { id: "dialogue-second", mediaId: "dialogue-media", start: 10, duration: 3, sourceStart: 5 },
    ],
    analyze: async ({ project }, range) => {
      ranges.push(range);
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-second")?.gainDb ?? 0;
      return { integratedLufs: -20 + gain, truePeakDb: -6 + gain, silenceMs: 100, analyzedDurationSeconds: 3, dialoguePresent: true };
    },
  });
  runtime.registerBuiltinSkills();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "dialogue-normalization",
    baseRevision: before.revision,
    input: { mediaId: "dialogue-media", occurrenceId: "dialogue-second" },
  });

  assert.equal(preview.plan.operations[0]?.type, "set-gain");
  assert.equal(preview.plan.operations[0]?.type === "set-gain" ? preview.plan.operations[0].clipId : undefined, "dialogue-second");
  assert.deepEqual(preview.plan.affectedRanges, [{ start: 10, end: 13 }]);
  assert.deepEqual(ranges, [{ start: 5, end: 8 }]);
});

test("unsafe dialogue decisions skip without changing canonical state", async () => {
  const cases = [
    { name: "no dialogue", options: { dialoguePresent: false }, reason: "NO_DIALOGUE" },
    { name: "silence", options: { silenceMs: 10_000 }, reason: "SILENCE" },
    { name: "insufficient duration", options: { analyzedDurationSeconds: 0.5, duration: 0.5 }, reason: "DIALOGUE_TOO_SHORT" },
    { name: "gain clamp", options: { integratedLufs: -30 }, reason: "GAIN_OUT_OF_BOUNDS" },
    { name: "peak risk", options: { truePeakDb: -2 }, reason: "PEAK_RISK" },
  ] as const;

  for (const current of cases) {
    const { runtime, adapter } = createFixture(current.options);
    runtime.registerBuiltinSkills();
    const { before, preview } = await previewDialogue(runtime);
    assert.equal(preview.plan.decision, "SKIP", current.name);
    assert.deepEqual(preview.plan.warnings, [current.reason], current.name);
    const result = await runtime.executeSkill(preview.previewToken);
    assert.equal(result.status, "SKIPPED", current.name);
    assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before), current.name);
  }
});

test("post-write true-peak failure rolls back the complete transaction", async () => {
  let calls = 0;
  const { runtime, adapter } = createFixture({
    analyze: async ({ project }) => {
      calls += 1;
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-occurrence")?.gainDb ?? 0;
      return {
        integratedLufs: -20 + gain,
        truePeakDb: calls === 1 ? -6 : -0.5,
        silenceMs: 100,
        analyzedDurationSeconds: 10,
        dialoguePresent: true,
      };
    },
  });
  runtime.registerBuiltinSkills();
  const { before, preview } = await previewDialogue(runtime);

  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(calls, 2);
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.rollback.succeeded, true);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("invalid post-write dialogue measurements roll back the transaction", async () => {
  let calls = 0;
  const { runtime, adapter } = createFixture({
    analyze: async ({ project }) => {
      calls += 1;
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-occurrence")?.gainDb ?? 0;
      return {
        integratedLufs: -20 + gain,
        truePeakDb: -6 + gain,
        silenceMs: 100,
        analyzedDurationSeconds: 10,
        dialoguePresent: true,
        valid: calls === 1,
        ...(calls === 1 ? {} : { invalidReason: "post-write analyzer rejected the sample" }),
      };
    },
  });
  runtime.registerBuiltinSkills();
  const { before, preview } = await previewDialogue(runtime);

  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(calls, 2);
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.rollback.succeeded, true);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

class UnexpectedDiffAdapter extends InMemoryEditorAdapter {
  public override async applyTransaction(
    operations: Parameters<InMemoryEditorAdapter["applyTransaction"]>[0],
    expectedRevision: Parameters<InMemoryEditorAdapter["applyTransaction"]>[1],
  ): Promise<void> {
    await super.applyTransaction(operations, expectedRevision);
    const after = await this.readProject();
    await this.apply({
      type: "add-marker",
      timelineId: after.timeline.id,
      marker: { id: "unauthorized-marker", start: 0, duration: 0, name: "Unauthorized" },
    }, after.revision);
  }
}

test("unexpected canonical changes roll back a dialogue Skill transaction", async () => {
  const fixture = createFixture();
  const adapter = new UnexpectedDiffAdapter({
    projectId: "dialogue-skill-project",
    projectName: "Dialogue Skill",
    timelineId: "dialogue-skill-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "dialogue-occurrence", mediaId: "dialogue-media", name: "Dialogue", start: 0, duration: 10, track: 1 }],
    media: [{ mediaId: "dialogue-media", source: "fixtures/dialogue.wav", mediaKind: "video", duration: 10 }],
  });
  const runtime = new AgentVideoRuntime(adapter, { audioAnalyzer: fixture.analyzer });
  runtime.registerBuiltinSkills();
  const { before, preview } = await previewDialogue(runtime);

  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.rollback.succeeded, true);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("dialogue Skill applies clip gain through the deterministic FCPXML adapter", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-dialogue-skill-"));
  const path = join(directory, "dialogue.fcpxml");
  await writeFile(path, `<?xml version="1.0"?><fcpxml version="1.11"><resources><asset id="dialogue-media" name="dialogue.wav" src="file:///dialogue.wav" duration="10s" /></resources><library><event><project uid="dialogue-project" name="Dialogue"><sequence uid="dialogue-sequence" name="Main" duration="10s"><spine><asset-clip id="dialogue-occurrence" ref="dialogue-media" name="Dialogue" offset="0s" duration="10s" /></spine></sequence></project></event></library></fcpxml>`);
  const adapter = new FcpxmlDocumentAdapter(path);
  const analyzer: AudioAnalyzer = {
    descriptor: { id: "fixture.fcpxml-dialogue", provider: "fixture", version: "1" },
    analyze: async ({ project }) => {
      const gain = project.timeline.clips[0]?.gainDb ?? 0;
      return { integratedLufs: -20 + gain, truePeakDb: -6 + gain, silenceMs: 100, analyzedDurationSeconds: 10, dialoguePresent: true };
    },
  };
  const runtime = new AgentVideoRuntime(adapter, { audioAnalyzer: analyzer });
  runtime.registerBuiltinSkills();
  const { preview } = await previewDialogue(runtime);

  const result = await runtime.executeSkill(preview.previewToken);

  assert.equal(result.status, "VERIFIED");
  assert.match(await readFile(path, "utf8"), /adjust-volume amount="4dB"/);
});
