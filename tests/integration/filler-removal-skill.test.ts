import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type ProjectSnapshot,
  type SpeechAnalyzer,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function createFixture(options: {
  words?: ProjectSnapshot["media"][number]["speech"]["words"];
  protectedSegments?: NonNullable<ProjectSnapshot["media"][number]["speech"]>["protectedSegments"];
} = {}) {
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
    clips: [{ id: "filler-occurrence", mediaId: "filler-media", name: "Interview", start: 0, duration: 5, track: 0 }],
    media: [{
      mediaId: "filler-media",
      source: "fixtures/interview.wav",
      duration: 5,
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
    analyze: async ({ project, media }) => {
      const clip = project.timeline.clips.find((candidate) => candidate.id === "filler-occurrence");
      if ((clip?.duration ?? 5) < 5) {
        return {
          words: words.filter((word) => word.filler !== true).map((word) => {
            const removed = words
              .filter((candidate) => candidate.filler === true && candidate.end <= word.start)
              .reduce((total, candidate) => total + candidate.end - candidate.start, 0);
            return { ...word, start: word.start - removed, end: word.end - removed };
          }),
          vadSegments: [{ start: 0, end: Math.max(0, (clip?.duration ?? 5) - 0.3), kind: "speech" as const }],
        };
      }
      return structuredClone(media.speech!);
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
    selectedDetails.candidates[0]?.id,
    suggested.id,
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

  await assert.rejects(runtime.executeSkill(preview.previewToken), /UNEXPECTED_DIFF/);
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
