import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type SpeechSegment,
  type SpeechAnalyzer,
  type SpeechWord,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createFixture(options: {
  words?: SpeechWord[];
  protectedSegments?: SpeechSegment[];
  postWords?: SpeechWord[];
  postAnalysisError?: boolean;
  clipDuration?: number;
  mediaDuration?: number;
} = {}) {
  const clipDuration = options.clipDuration ?? 5;
  const mediaDuration = options.mediaDuration ?? clipDuration;
  const words = options.words ?? [
    { text: "hello", start: 0.2, end: 0.6, confidence: 0.99 },
    { text: "um", start: 0.8, end: 1.1, confidence: 0.98, filler: true },
    { text: "world", start: 1.3, end: 1.8, confidence: 0.99 },
    { text: "uh", start: 2, end: 2.3, confidence: 0.7 },
  ];
  const adapter = new InMemoryEditorAdapter({
    projectId: "skill-filler-project",
    projectName: "Skill Filler Fixture",
    timelineId: "skill-filler-timeline",
    timelineName: "Main Edit",
      clips: [{ id: "filler-occurrence", mediaId: "filler-media", name: "Interview", start: 0, duration: clipDuration, track: 0 }],
    media: [{
      mediaId: "filler-media",
      source: "fixtures/interview.wav",
      duration: mediaDuration,
      speech: {
        words,
        vadSegments: [
          { start: 0, end: 0.7, kind: "speech" },
          { start: 0.7, end: 0.8, kind: "silence" },
          { start: 0.8, end: 1.1, kind: "speech" },
          { start: 1.1, end: 1.3, kind: "silence" },
          { start: 1.3, end: 1.8, kind: "speech" },
          { start: 1.8, end: 2, kind: "silence" },
          { start: 2, end: 2.3, kind: "speech" },
        ],
        silenceSegments: [
          { start: 0.7, end: 0.8, kind: "silence" },
          { start: 1.1, end: 1.3, kind: "silence" },
          { start: 1.8, end: 2, kind: "silence" },
        ],
        ...(options.protectedSegments ? { protectedSegments: options.protectedSegments } : {}),
      },
    }],
  });
  const analyzer: SpeechAnalyzer = {
    capabilities: { transcription: true, vad: true },
    analyze: async ({ project, media }, range) => {
      const clip = project.timeline.clips.find((candidate) => candidate.id === "filler-occurrence");
      if ((clip?.duration ?? clipDuration) < clipDuration) {
        if (options.postAnalysisError) throw new Error("controlled post-write analyzer failure");
        const postWords = options.postWords ?? words.filter((word) => word.filler !== true);
        const scopedWords = range
          ? postWords.filter((word) => word.start >= range.start && word.end <= range.end)
          : postWords;
        return {
          words: scopedWords,
          vadSegments: [{ start: 0, end: Math.max(0, (clip?.duration ?? 5) - 0.3), kind: "speech" as const }],
        };
      }
      const scopedWords = range
        ? media.speech!.words.filter((word) => word.start >= range.start && word.end <= range.end)
        : media.speech!.words;
      return {
        ...structuredClone(media.speech!),
        words: scopedWords,
      };
    },
  };
  return { adapter, analyzer, runtime: new AgentVideoRuntime(adapter, { speechAnalyzer: analyzer }) };
}

function register(runtime: AgentVideoRuntime): void {
  runtime.registerBuiltinSkills();
}

test("filler Skill is unavailable before planning when VAD is missing", async () => {
  const { adapter } = createFixture();
  const runtime = new AgentVideoRuntime(adapter, {
    speechAnalyzer: {
      capabilities: { transcription: true, vad: false },
      analyze: async ({ media }) => structuredClone(media.speech!),
    },
  });
  register(runtime);

  const inspection = await runtime.inspectSkillAvailability("filler-removal");

  assert.equal(inspection.availability.available, false);
  assert.ok(inspection.availability.missingRequirements.some((item) => item.name === "speechVad"));
});

test("filler Skill preview returns decisions and evidence without mutation", async () => {
  const { adapter, runtime } = createFixture();
  register(runtime);
  const before = await runtime.inspectProject();

  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });
  const details = preview.plan.details as {
    candidates: Array<{ id: string; word: { text: string } }>;
    decisions: Array<{ candidateId: string; status: string; evidence: unknown }>;
    candidateProvenance: Array<{ candidateId: string; operationIndex: number }>;
  };

  assert.equal(details.candidates.length, 2);
  assert.deepEqual(details.candidates.map((candidate) => candidate.word.text), ["um", "uh"]);
  assert.deepEqual(details.decisions.map((decision) => decision.status), ["AUTO_APPLY", "SUGGESTED"]);
  assert.ok(details.decisions.every((decision) => decision.evidence));
  assert.equal(preview.plan.operations.length, 1);
  assert.equal((preview.plan.operations[0] as { candidateId?: string }).candidateId, details.candidates[0]?.id);
  assert.equal(details.candidateProvenance.length, 1);
  assert.deepEqual(await adapter.readProject(), before);
});

test("suggested filler candidates require an explicit re-preview selection", async () => {
  const { runtime } = createFixture();
  register(runtime);
  const before = await runtime.inspectProject();
  const initial = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });
  const initialDetails = initial.plan.details as { candidates: Array<{ id: string; word: { text: string } }> };
  const suggested = initialDetails.candidates.find((candidate) => candidate.word.text === "uh");
  assert.ok(suggested);

  const selected = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 }, selectedCandidateIds: [suggested.id] },
  });
  const selectedDetails = selected.plan.details as { candidates: Array<{ id: string }>; decisions: Array<{ candidateId: string; status: string }> };

  assert.equal(selected.plan.operations.length, 2);
  assert.equal(selectedDetails.decisions.find((decision) => decision.candidateId === suggested.id)?.status, "SUGGESTED");
  assert.deepEqual((selected.plan.operations as Array<{ candidateId?: string }>).map((operation) => operation.candidateId), [
    suggested.id,
    selectedDetails.candidates[0]?.id,
  ]);
});

test("zero valid filler candidates execute as a verified no-op", async () => {
  const { adapter, runtime } = createFixture({
    words: [
      { text: "uh", start: 1, end: 1.3, confidence: 0.7 },
    ],
  });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });

  assert.equal(preview.plan.operations.length, 0);
  const execution = await runtime.executeSkill(preview.previewToken);

  assert.equal(execution.status, "VERIFIED");
  assert.deepEqual(execution.transactionIds, []);
  assert.deepEqual(await adapter.readProject(), before);
});

test("filler Skill applies all authorized cuts in one composite transaction with provenance", async () => {
  const { adapter, runtime } = createFixture();
  register(runtime);
  let compositeCalls = 0;
  const applyTransaction = adapter.applyTransaction!.bind(adapter);
  adapter.applyTransaction = async (...args) => {
    compositeCalls += 1;
    return applyTransaction(...args);
  };
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 }, selectedCandidateIds: [] },
  });
  const execution = await runtime.executeSkill(preview.previewToken);
  const details = execution.details as { candidateProvenance: Array<{ candidateId: string; operationIndex: number; diffRanges: unknown[] }> };

  assert.equal(execution.status, "VERIFIED");
  assert.equal(compositeCalls, 1);
  assert.equal(execution.transactionIds.length, 1);
  assert.equal(details.candidateProvenance.length, 1);
  assert.equal(details.candidateProvenance[0]?.operationIndex, 0);
  assert.ok(details.candidateProvenance[0]?.diffRanges.length);
  assert.ok(Math.abs((execution.diff?.durationDelta ?? 0) + 0.3) < 0.000001);
});

test("source-media speech timestamps remain unchanged after ripple delete", async () => {
  const { runtime } = createFixture({
    postWords: [
      { text: "hello", start: 0.2, end: 0.6, confidence: 0.99 },
      { text: "world", start: 1.3, end: 1.8, confidence: 0.99 },
      { text: "uh", start: 2, end: 2.3, confidence: 0.7 },
    ],
  });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });

  const execution = await runtime.executeSkill(preview.previewToken);

  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.verification?.checks.find((check) => check.name === "filler-speech-continuity")?.passed, true);
});

test("repeated filler text outside the selected range remains independent", async () => {
  const words: SpeechWord[] = [
    { text: "hello", start: 0.2, end: 0.6, confidence: 0.99 },
    { text: "um", start: 0.8, end: 1.1, confidence: 0.98, filler: true },
    { text: "world", start: 1.3, end: 1.8, confidence: 0.99 },
    { text: "hello", start: 3, end: 3.4, confidence: 0.99 },
    { text: "um", start: 3.6, end: 3.9, confidence: 0.98, filler: true },
    { text: "world", start: 4.1, end: 4.6, confidence: 0.99 },
  ];
  const { runtime } = createFixture({
    words,
    clipDuration: 5,
    mediaDuration: 5,
    postWords: words.filter((word) => word.start !== 0.8),
  });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 2.5 } },
  });

  assert.equal(preview.plan.operations.length, 1);
  const execution = await runtime.executeSkill(preview.previewToken);

  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.verification?.checks.find((check) => check.name === "filler-targets-absent")?.passed, true);
});

test("unexpected canonical changes roll back the complete filler transaction", async () => {
  const { adapter, runtime } = createFixture();
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });
  const applyTransaction = adapter.applyTransaction!.bind(adapter);
  adapter.applyTransaction = async (operations, revision) => {
    await applyTransaction(operations, revision);
    const current = await adapter.readProject();
    await adapter.apply({
      type: "add-marker",
      timelineId: current.timeline.id,
      marker: { id: "unexpected", start: 0, duration: 0, name: "Unexpected" },
    }, current.revision);
  };

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "ROLLED_BACK");
  assert.ok(execution.verification?.checks.some((check) => check.reason === "UNEXPECTED_DIFF"));
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("protected speech is never authorized for automatic filler removal", async () => {
  const { runtime } = createFixture({ protectedSegments: [{ start: 0.9, end: 1.05, kind: "breath" }] });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });
  const details = preview.plan.details as { decisions: Array<{ candidateId: string; status: string; reasonCodes: string[] }> };
  const umDecision = details.decisions.find((decision) => decision.reasonCodes.includes("PROTECTED_SEGMENT_OVERLAP"));

  assert.equal(umDecision?.status, "SKIPPED");
  assert.equal(preview.plan.operations.length, 0);
  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "VERIFIED");
});

test("invalid candidate selections are rejected during re-preview", async () => {
  const { runtime } = createFixture();
  register(runtime);
  const before = await runtime.inspectProject();

  await assert.rejects(runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 }, selectedCandidateIds: ["missing-candidate"] },
  }), /CANDIDATE_NOT_FOUND/);
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("partial composite failures roll back every applied filler operation", async () => {
  const { adapter, runtime } = createFixture();
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });
  const firstOperation = preview.plan.operations.find((operation) => operation.type === "ripple-delete");
  if (!firstOperation) throw new Error("test fixture did not produce a ripple-delete operation");
  adapter.applyTransaction = async (operations, revision) => {
    await adapter.apply(firstOperation, revision);
    throw new Error("controlled partial composite failure");
  };

  await assert.rejects(runtime.executeSkill(preview.previewToken), /TRANSACTION_FAILED/);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("post-write analysis failures roll back the complete filler transaction", async () => {
  const { adapter, runtime } = createFixture({ postAnalysisError: true });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });

  await assert.rejects(runtime.executeSkill(preview.previewToken), /ANALYSIS_FAILED/);
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});

test("speech continuity failure rolls back adjacent ordered speech", async () => {
  const { adapter, runtime } = createFixture({
    postWords: [{ text: "hello", start: 0.2, end: 0.6, confidence: 0.99 }],
  });
  register(runtime);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "filler-removal",
    baseRevision: before.revision,
    input: { range: { start: 0, end: 5 } },
  });

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "ROLLED_BACK");
  assert.ok(execution.verification?.checks.some((check) => check.reason === "SPEECH_CONTINUITY_CHANGED"));
  assert.equal(canonicalSnapshotDigest(await adapter.readProject()), canonicalSnapshotDigest(before));
});
