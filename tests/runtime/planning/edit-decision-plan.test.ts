import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCreativeBrief, InMemorySemanticMediaIndexStore, InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyLocalMediaSource, type CreativeBrief } from "../../../packages/runtime/src/index.js";
import { createEditDecisionPlan, assertEditDecisionPlanCurrent } from "../../../packages/runtime/src/planning/edit-decision-plan.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "framekit-decision-"));
  const path = join(dir, "source.mov"); await writeFile(path, "source bytes");
  const source = { mediaId: "m", source: path, sourceDigest: createHash("sha256").update("source bytes").digest("hex"), mediaKind: "video" as const, duration: 10 };
  const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
  const provider = { id: "speech", provider: "fixture", version: "1", model: "model-v1", configurationDigest: "config-v1" };
  const speech = { coverageProvenance: "provider" as const, schemaVersion: 1 as const, mediaId: "m", sourceIdentity: source, revision, provider,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-plus-vad" as const,
    words: [{ text: "Hello.", start: 1, end: 2, confidence: 0.98 }, { text: "Again", start: 4, end: 5, confidence: 0.96 }],
    vadSegments: [{ kind: "speech" as const, start: 1, end: 2 }, { kind: "speech" as const, start: 4, end: 5 }] };
  const record = { mediaId: "m", source: path, sourceIdentity: source, analysisRevision: revision, speech,
    semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
    analysis: [{ capability: "speech" as const, status: "analyzed" as const, provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }] };
  const index = new InMemorySemanticMediaIndexStore(); await index.save(record);
  const artifacts = new InMemoryAnalysisArtifactStore();
  const speechContext = { kind: "speech" as const, source, provider, revision, range: { start: 0, end: 10 } };
  const vadContext = { ...speechContext, kind: "vad" as const };
  const speechRef = await pinAnalysisEvidence(index, artifacts, speechContext, verifyLocalMediaSource);
  const vadRef = await pinAnalysisEvidence(index, artifacts, vadContext, verifyLocalMediaSource);
  const snapshot = { projectId: "p", projectName: "P", revision, media: [source], timeline: { id: "t", name: "T", duration: 10, frameDuration: { value: "1", timescale: "10" },
    clips: [{ id: "clip", mediaId: "m", name: "Interview", start: 0, duration: 10, sourceStart: 0, sourceStartTime: { value: "0", timescale: "1" }, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" }, track: 1 }], storyElements: [], captions: [], markers: [] } };
  const brief: CreativeBrief = { schemaVersion: 1, id: "b", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" }, durationSeconds: { min: 5, max: 10 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural", requiredContent: [], excludedContent: [], sourceCoverage: [], speechPolicy: { kind: "specified", value: "preserve" }, musicPolicy: { kind: "specified", value: "none" }, captionPolicy: { kind: "specified", value: "basic" }, inferences: [], reviewPrompts: [] };
  const request = { snapshot, projectId: "p", timelineId: "t", revision, occurrenceId: "clip", brief, accepted: acceptCreativeBrief(brief), speechRef, vadRef, speechContext, vadContext,
    caption: { style: "basic", maxWordsPerGroup: 3, maxCharsPerLine: 20, maxLines: 2, emphasisWordIndices: [] },
    music: { occurrenceId: "music", placement: { start: 0, end: 5 }, targetLane: -1, context: { speech: "present" as const, audioEvidence: "unavailable" as const }, capabilities: { staticMusicPreview: false, ducking: false, fades: false } } };
  return { dir, path, request, artifacts };
}

test("integrates verified speech cuts, captions and explicit music omission without mutation", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.request.snapshot);
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.deepEqual(f.request.snapshot, before);
    assert.equal(result.plan.reviewRequired, true);
    assert.ok(result.plan.decisions.some((item) => item.kind === "cut"));
    assert.ok(result.plan.decisions.some((item) => item.kind === "caption"));
    assert.ok(result.plan.decisions.some((item) => item.kind === "music-omission"));
    assert.ok(result.plan.decisions.filter((item) => item.kind !== "music-omission").every((item) => item.support === "unavailable"));
    assert.deepEqual(await assertEditDecisionPlanCurrent(f.request, result.plan, f.artifacts, verifyLocalMediaSource), { status: "current" });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("changes to the approved brief, target, source or evidence reject the plan", async () => {
  const f = await fixture();
  try {
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available"); if (result.status !== "available") return;
    const changedBrief = { ...f.request, brief: { ...f.request.brief, theme: "changed" } };
    assert.notEqual((await assertEditDecisionPlanCurrent(changedBrief, result.plan, f.artifacts, verifyLocalMediaSource)).status, "current");
    const changedTarget = { ...f.request, timelineId: "other" };
    assert.notEqual((await assertEditDecisionPlanCurrent(changedTarget, result.plan, f.artifacts, verifyLocalMediaSource)).status, "current");
    await writeFile(f.path, "replacement");
    assert.notEqual((await assertEditDecisionPlanCurrent(f.request, result.plan, f.artifacts, verifyLocalMediaSource)).status, "current");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
