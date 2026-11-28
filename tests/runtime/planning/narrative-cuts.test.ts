import assert from "node:assert/strict";
import { test } from "node:test";
import { rankNarrativeCuts } from "../../../packages/runtime/src/planning/narrative-cuts.js";

const revision = { id: "rev-1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const source = { mediaId: "source", source: "source.mov", sourceDigest: "sha256:source", duration: 10 };
const input = {
  source, revision, projectId: "project-1", timelineId: "sequence-1", occurrenceId: "clip-1", sourceRange: { start: 0, end: 10, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }, sequenceRange: { start: 20, end: 30, startTime: { value: "20", timescale: "1" }, durationTime: { value: "10", timescale: "1" } },
  sequenceFrameDuration: { value: "1", timescale: "10" },
  analysis: {
    schemaVersion: 1 as const, mediaId: source.mediaId, sourceIdentity: source, revision,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 },
    provider: { id: "speech", provider: "fixture", version: "1" }, sourceTimebase: { value: "1", timescale: "1000" },
    capability: "transcription-plus-vad" as const,
    words: [{ text: "Complete.", start: 0, end: 1, confidence: 0.99 }, { text: "Next", start: 3, end: 4, confidence: 0.99 }],
    vadSegments: [{ kind: "speech" as const, start: 0, end: 1 }, { kind: "silence" as const, start: 1, end: 3 }, { kind: "speech" as const, start: 3, end: 4 }],
  },
};

test("ranks a review-only pause between complete thoughts with source and sequence evidence", () => {
  const before = structuredClone(input);
  const result = rankNarrativeCuts(input);
  assert.deepEqual(input, before);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.ok(candidate.sourceRange.start >= 1.2 && candidate.sourceRange.end <= 2.8);
  assert.ok(candidate.sequenceRange.start >= 21.2 && candidate.sequenceRange.end <= 22.8);
  assert.ok(candidate.sequenceRange.startTime && candidate.sequenceRange.durationTime);
  assert.equal(candidate.occurrenceId, "clip-1");
  assert.equal(candidate.reviewRequired, true);
  assert.ok(candidate.rationale);
  assert.ok(candidate.evidence.length > 0);
  assert.deepEqual(result.revision, revision);
  assert.equal(result.projectId, "project-1");
  assert.equal(result.timelineId, "sequence-1");
});

test("does not recommend ambiguous speech, protected content or unobserved silence", () => {
  const protectedInput = { ...input, analysis: { ...input.analysis, protectedSegments: [{ kind: "speech" as const, start: 1.5, end: 2 }] } };
  assert.equal(rankNarrativeCuts(protectedInput).candidates.length, 0);
  const incomplete = { ...input, analysis: { ...input.analysis, observedRange: { start: 0, end: 2 } } };
  assert.equal(rankNarrativeCuts(incomplete).candidates.length, 0);
  const midThought = { ...input, analysis: { ...input.analysis, words: [{ ...input.analysis.words[0]!, text: "Incomplete" }, input.analysis.words[1]!] } };
  assert.equal(rankNarrativeCuts(midThought).candidates.length, 0);
  const noVad = { ...input, analysis: { ...input.analysis, vadSegments: undefined } };
  assert.equal(rankNarrativeCuts(noVad).candidates.length, 0);
});

test("visual gaps alone never authorize a cut, and stale or retimed mappings fail", () => {
  const visualOnly = { ...input, analysis: { ...input.analysis, vadSegments: undefined }, visualGaps: [{ start: 1, end: 3 }] };
  assert.equal(rankNarrativeCuts(visualOnly).candidates.length, 0);
  assert.throws(() => rankNarrativeCuts({ ...input, revision: { ...revision, sequence: 2 } }), /STALE/);
  assert.throws(() => rankNarrativeCuts({ ...input, sequenceRange: { start: 20, end: 25 } }), /AMBIGUOUS/);
});


test("rejects low-confidence or overlapping words, VAD contradictions and stale source", () => {
  const low = { ...input, analysis: { ...input.analysis, words: [{ ...input.analysis.words[0]!, confidence: 0.1 }, input.analysis.words[1]!] } };
  assert.equal(rankNarrativeCuts(low).candidates.length, 0);
  const overlap = { ...input, analysis: { ...input.analysis, vadSegments: [...input.analysis.vadSegments, { kind: "speech" as const, start: 1.5, end: 2 }] } };
  assert.equal(rankNarrativeCuts(overlap).candidates.length, 0);
  assert.throws(() => rankNarrativeCuts({ ...input, source: { ...source, sourceDigest: "sha256:changed" } }), /SOURCE|TARGET/);
});

test("explains why sentence pauses produce no safe candidates", () => {
  const lowConfidence = { ...input, analysis: { ...input.analysis, words: [input.analysis.words[0]!, { ...input.analysis.words[1]!, confidence: 0.71 }] } };
  const low = rankNarrativeCuts(lowConfidence);
  assert.equal(low.candidates.length, 0);
  assert.ok(low.warnings.some((warning) => /confidence.*review/i.test(warning)));
  const short = { ...input, analysis: { ...input.analysis,
    words: [{ ...input.analysis.words[0]!, end: 1 }, { ...input.analysis.words[1]!, start: 1.74 }],
    vadSegments: [{ kind: "speech" as const, start: 0, end: 1 }, { kind: "silence" as const, start: 1, end: 1.74 }, { kind: "speech" as const, start: 1.74, end: 4 }],
  } };
  const result = rankNarrativeCuts(short);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.warnings.some((warning) => /pause.*short/i.test(warning)));
  assert.equal(rankNarrativeCuts(input).warnings.some((warning) => /no safe candidates/i.test(warning)), false);
});

test("requires exact timeline identity and reports unavailable evidence", () => {
  assert.throws(() => rankNarrativeCuts({ ...input, sequenceRange: { start: 20, end: 30 } }), /AMBIGUOUS|ANALYSIS/);
  const result = rankNarrativeCuts({ ...input, analysis: { ...input.analysis, vadSegments: undefined } });
  assert.ok(result.warnings.length > 0);
});

test("preserves exact source and sequence timing for fractional frame candidates", () => {
  const result = rankNarrativeCuts({ ...input, sequenceRange: { start: 0, end: 10, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }, sequenceFrameDuration: { value: "1001", timescale: "24000" } });
  assert.equal(result.candidates.length, 1);
  const cut = result.candidates[0]!;
  assert.ok(cut.sourceRange.startTime && cut.sourceRange.durationTime);
  assert.ok(cut.sequenceRange.startTime && cut.sequenceRange.durationTime);
  const seconds = (time: { value: string; timescale: string }) => Number(time.value) / Number(time.timescale);
  assert.ok(Math.abs(seconds(cut.sourceRange.startTime) - cut.sourceRange.start) < 1e-9);
  assert.ok(Math.abs(seconds(cut.sequenceRange.startTime) - cut.sequenceRange.start) < 1e-9);
  assert.ok(Math.abs(seconds(cut.sourceRange.durationTime) - (cut.sourceRange.end - cut.sourceRange.start)) < 1e-9);
});


test("requires exact project and timeline identities", () => {
  assert.throws(() => rankNarrativeCuts({ ...input, projectId: "" }), /TARGET/);
  assert.throws(() => rankNarrativeCuts({ ...input, timelineId: "" }), /TARGET/);
});

test("ranks visual context only among speech-safe suggestions and reports uncertain VAD", () => {
  const three = { ...input, visualGaps: [{ start: 4, end: 7 }], analysis: { ...input.analysis,
    words: [...input.analysis.words.slice(0, 1), { text: "Second.", start: 3, end: 4, confidence: 0.99 }, { text: "Third", start: 7, end: 8, confidence: 0.99 }],
    vadSegments: [...input.analysis.vadSegments, { kind: "silence" as const, start: 4, end: 7 }, { kind: "speech" as const, start: 7, end: 8 }],
  } };
  const result = rankNarrativeCuts(three);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[0]!.sourceRange.start > result.candidates[1]!.sourceRange.start);
  assert.ok(result.candidates[0]!.evidence.some((entry) => /visual/i.test(entry)));
  assert.ok(result.warnings.some((warning) => /confidence/i.test(warning)));
  assert.ok(result.candidates.every((candidate) => candidate.reviewRequired));
});

test("narrative ranking is exposed through the runtime package", async () => {
  const runtime = await import("../../../packages/runtime/src/index.js");
  assert.equal(typeof (runtime as Record<string, unknown>).rankNarrativeCuts, "function");
});

test("supports speech-only VAD with complete observed coverage as an uncertain review suggestion", () => {
  const speechOnly = { ...input, analysis: { ...input.analysis, vadSegments: input.analysis.vadSegments.filter((segment) => segment.kind === "speech") } };
  const result = rankNarrativeCuts(speechOnly);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0]!.evidence.some((item) => /non-speech/i.test(item)));
  assert.ok(result.warnings.some((item) => /uncertain/i.test(item)));
  const incomplete = { ...speechOnly, analysis: { ...speechOnly.analysis, vadCoverage: [{ status: "unavailable" as const, start: 0, end: 10, reason: "detector failed" }] } };
  assert.equal(rankNarrativeCuts(incomplete).candidates.length, 0);
});

test("rejects a pause when VAD does not corroborate the surrounding speech", () => {
  const empty = { ...input, analysis: { ...input.analysis, vadSegments: [] } };
  assert.equal(rankNarrativeCuts(empty).candidates.length, 0);
  const silenceOnly = { ...input, analysis: { ...input.analysis, vadSegments: [{ kind: "silence" as const, start: 1, end: 3 }] } };
  assert.equal(rankNarrativeCuts(silenceOnly).candidates.length, 0);
});

test("adjusted cuts must stay inside the freshly recomputed safe candidate", async () => {
  const { adjustNarrativeCut } = await import("../../../packages/runtime/src/planning/narrative-cuts.js");
  const candidate = rankNarrativeCuts(input).candidates[0]!;
  const adjusted = { start: 21.5, end: 22.5, startTime: { value: "215", timescale: "10" }, durationTime: { value: "10", timescale: "10" } };
  const result = adjustNarrativeCut(input, candidate, adjusted);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.sourceRange.start, 1.5);
  assert.equal(result.sourceRange.end, 2.5);
  assert.deepEqual(result.sequenceRange, adjusted);
  assert.ok(result.sourceRange.startTime && result.sourceRange.durationTime);
  assert.throws(() => adjustNarrativeCut(input, candidate, { ...adjusted, start: 21, startTime: { value: "21", timescale: "1" }, durationTime: { value: "15", timescale: "10" } }), /UNSAFE|INVALID/);
  assert.throws(() => adjustNarrativeCut(input, candidate, { ...adjusted, start: 21.51, startTime: { value: "2151", timescale: "100" }, durationTime: { value: "99", timescale: "100" } }), /FRAME|INVALID/);
  assert.throws(() => adjustNarrativeCut(input, candidate, { ...adjusted, end: 22.6 }), /INVALID/);
  assert.throws(() => adjustNarrativeCut({ ...input, revision: { ...revision, sequence: 2 } }, candidate, adjusted), /STALE/);
  const protectedInput = { ...input, analysis: { ...input.analysis, protectedSegments: [{ kind: "speech" as const, start: 2, end: 2.1 }] } };
  assert.throws(() => adjustNarrativeCut(protectedInput, candidate, adjusted), /STALE|UNSAFE/);
});

test("adjustment rejects unchanged geometry when target or transcript evidence changes", async () => {
  const { adjustNarrativeCut } = await import("../../../packages/runtime/src/planning/narrative-cuts.js");
  const candidate = rankNarrativeCuts(input).candidates[0]!;
  const adjusted = { start: 21.5, end: 22.5, startTime: { value: "215", timescale: "10" }, durationTime: { value: "10", timescale: "10" } };
  assert.throws(() => adjustNarrativeCut({ ...input, projectId: "other-project" }, candidate, adjusted), /STALE/);
  assert.throws(() => adjustNarrativeCut({ ...input, timelineId: "other-timeline" }, candidate, adjusted), /STALE/);
  const changedWords = [{ ...input.analysis.words[0]!, text: "Different." }, input.analysis.words[1]!];
  assert.throws(() => adjustNarrativeCut({ ...input, analysis: { ...input.analysis, words: changedWords } }, candidate, adjusted), /STALE/);
});

test("pinned VAD evidence is verified before ranking and changed artifacts fail closed", async () => {
  const { InMemorySemanticMediaIndexStore, InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyLocalMediaSource } = await import("../../../packages/runtime/src/index.js");
  const { rankNarrativeCutsWithEvidence, adjustNarrativeCutWithEvidence } = await import("../../../packages/runtime/src/planning/narrative-cuts.js");
  const { createHash } = await import("node:crypto");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "framekit-narrative-evidence-"));
  try {
    const path = join(dir, "media.mov");
    await writeFile(path, "source bytes");
    const localSource = { ...source, source: path, sourceDigest: createHash("sha256").update("source bytes").digest("hex") };
    const provider = { id: "speech", provider: "fixture", version: "1", model: "fixture-v1", configurationDigest: "config-v1" };
    const speech = { ...input.analysis, sourceIdentity: localSource, provider, coverageProvenance: "provider" as const };
    const record = { mediaId: localSource.mediaId, source: path, sourceIdentity: localSource, analysisRevision: revision, speech,
      semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
      analysis: [{ capability: "speech" as const, status: "analyzed" as const, provenance: { source: localSource, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }] };
    const index = new InMemorySemanticMediaIndexStore();
    await index.save(record);
    const artifacts = new InMemoryAnalysisArtifactStore();
    const evidenceContext = { kind: "vad" as const, source: localSource, provider, revision, range: { start: 0, end: 10 } };
    const ref = await pinAnalysisEvidence(index, artifacts, evidenceContext, verifyLocalMediaSource);
    const { analysis: _analysis, ...request } = input;
    const localRequest = { ...request, source: localSource };
    const result = await rankNarrativeCutsWithEvidence(localRequest, ref, evidenceContext, artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    assert.equal(result.plan.candidates.length, 1);
    const candidate = result.plan.candidates[0]!;
    const nextRevision = { ...revision, id: "r2", sequence: 2 };
    const nextContext = { ...evidenceContext, revision: nextRevision };
    const reboundRef = await pinAnalysisEvidence(index, artifacts, nextContext, verifyLocalMediaSource);
    const movedRequest = { ...localRequest, revision: nextRevision, sequenceRange: { start: 25, end: 35,
      startTime: { value: "25", timescale: "1" }, durationTime: { value: "10", timescale: "1" } } };
    const moved = await rankNarrativeCutsWithEvidence(movedRequest, reboundRef, nextContext, artifacts, verifyLocalMediaSource);
    assert.equal(moved.status, "available");
    if (moved.status !== "available") return;
    assert.equal(moved.plan.candidates.length, 1);
    assert.equal(moved.plan.candidates[0]!.sequenceRange.start, candidate.sequenceRange.start + 5);
    assert.notEqual(moved.plan.candidates[0]!.inputDigest, candidate.inputDigest);
    const adjusted = { start: 21.5, end: 22.5, startTime: { value: "215", timescale: "10" }, durationTime: { value: "10", timescale: "10" } };
    assert.notEqual((await adjustNarrativeCutWithEvidence(movedRequest, reboundRef, nextContext, artifacts, verifyLocalMediaSource, candidate, adjusted)).status, "available");
    const adjustment = await adjustNarrativeCutWithEvidence(localRequest, ref, evidenceContext, artifacts, verifyLocalMediaSource, candidate, adjusted);
    assert.equal(adjustment.status, "available");
    await index.save({ ...record, semantic: { ...record.semantic, moods: [{ value: "changed", confidence: 0.9 }] } });
    const alternateRef = await pinAnalysisEvidence(index, artifacts, evidenceContext, verifyLocalMediaSource);
    assert.notEqual(alternateRef.artifactDigest, ref.artifactDigest);
    assert.notEqual((await adjustNarrativeCutWithEvidence(localRequest, alternateRef, evidenceContext, artifacts, verifyLocalMediaSource, candidate, adjusted)).status, "available");
    const mutableRef = structuredClone(ref);
    const swapped = await rankNarrativeCutsWithEvidence(localRequest, mutableRef, evidenceContext, artifacts, async (source) => {
      mutableRef.artifactDigest = alternateRef.artifactDigest;
      await verifyLocalMediaSource(source);
    });
    assert.deepEqual(swapped, result, "ranking must use the evidence reference supplied before awaiting");
    const original = await artifacts.get(ref.artifactDigest);
    let reads = 0;
    const changedBetweenReads = { get: async () => ++reads === 1 ? original : Buffer.from("{}"), put: async () => {} };
    assert.notEqual((await rankNarrativeCutsWithEvidence(localRequest, ref, evidenceContext, changedBetweenReads, verifyLocalMediaSource)).status, "available");
    const wrongRevision = { ...evidenceContext, revision: { ...revision, sequence: 2 } };
    assert.notEqual((await rankNarrativeCutsWithEvidence({ ...localRequest, revision: wrongRevision.revision }, ref, wrongRevision, artifacts, verifyLocalMediaSource)).status, "available");
    const wrongProvider = { ...evidenceContext, provider: { ...provider, model: "different" } };
    assert.notEqual((await rankNarrativeCutsWithEvidence(localRequest, ref, wrongProvider, artifacts, verifyLocalMediaSource)).status, "available");
    await writeFile(path, "replacement");
    assert.notEqual((await adjustNarrativeCutWithEvidence(localRequest, ref, evidenceContext, artifacts, verifyLocalMediaSource, candidate, adjusted)).status, "available");
    assert.notEqual((await rankNarrativeCutsWithEvidence(localRequest, ref, evidenceContext, artifacts, verifyLocalMediaSource)).status, "available");
    const corrupt = { get: async () => Buffer.from("{}"), put: async () => {} };
    assert.notEqual((await rankNarrativeCutsWithEvidence(localRequest, ref, evidenceContext, corrupt, async () => {})).status, "available");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("partially corroborated neighboring words retain both VAD and transcript margins", () => {
  const partial = { ...input, analysis: { ...input.analysis, vadSegments: [
    { kind: "speech" as const, start: 0, end: 1.1 },
    { kind: "speech" as const, start: 3.4, end: 4 },
  ] } };
  const result = rankNarrativeCuts(partial);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.ok(candidate.sourceRange.start >= 1.3);
  assert.ok(candidate.sourceRange.end <= 2.8);
  assert.ok(result.warnings.some((warning) => /partial.*review/i.test(warning)));
  assert.equal(result.warnings.includes("VAD silence confidence is unavailable."), false);
  assert.equal(candidate.reviewRequired, true);
  const explicitSilence = { ...partial, analysis: { ...partial.analysis, vadSegments: [partial.analysis.vadSegments[0]!,
    { kind: "silence" as const, start: 1.1, end: 3, confidence: 0.99 }, partial.analysis.vadSegments[1]!] } };
  const bounded = rankNarrativeCuts(explicitSilence);
  assert.equal(bounded.candidates.length, 1);
  assert.ok(bounded.candidates[0]!.confidence <= 0.5);
  const unrelatedSpeech = { ...partial, analysis: { ...partial.analysis, vadSegments: [...partial.analysis.vadSegments,
    { kind: "speech" as const, start: 2, end: 2.3 }].sort((a, b) => a.start - b.start) } };
  assert.equal(rankNarrativeCuts(unrelatedSpeech).candidates.length, 0);
  const weakOverlap = { ...partial, analysis: { ...partial.analysis, vadSegments: [partial.analysis.vadSegments[0]!,
    { kind: "speech" as const, start: 3.99, end: 4 }] } };
  assert.equal(rankNarrativeCuts(weakOverlap).candidates.length, 0);
});

test("retains a VAD-observed word omitted by the transcript at a real conversational boundary", () => {
  // AMI EN2002a, 120–180 s; the reference places a missed word at 42.68–43.00 s.
  // The corpus word timings are automatically aligned and are not precise ground truth.
  const duration = { value: "60", timescale: "1" };
  const range = { start: 0, end: 60, startTime: { value: "0", timescale: "1" }, durationTime: duration };
  const realBoundary = { ...input, source: { ...source, duration: 60 }, sourceRange: range, sequenceRange: range,
    sequenceFrameDuration: { value: "1", timescale: "30" },
    analysis: { ...input.analysis, sourceIdentity: { ...source, duration: 60 }, requestedRange: { start: 0, end: 60 }, observedRange: { start: 0, end: 60 },
      words: [{ text: "think.", start: 40.4, end: 40.7, confidence: 1 }, { text: "So", start: 42.88, end: 43.18, confidence: 0.84 }],
      vadSegments: [{ kind: "speech" as const, start: 38.978, end: 40.766 }, { kind: "speech" as const, start: 42.69, end: 46.046 }] } };
  const plan = rankNarrativeCuts(realBoundary);
  assert.equal(plan.candidates.length, 1);
  assert.ok(plan.candidates[0]!.sourceRange.end < 42.68, "the candidate must end before the independently timed missing word");
  assert.ok(plan.warnings.some((warning) => /uncertain.*listening/i.test(warning)));
});

test("suggests a long reviewed pause with partially aligned adjacent VAD", () => {
  // Controlled editorial QA: the word begins before the VAD detects its speech.
  const range = { start: 0, end: 11, startTime: { value: "0", timescale: "1" }, durationTime: { value: "11", timescale: "1" } };
  const partial = { ...input, source: { ...source, duration: 11 }, sourceRange: range, sequenceRange: range,
    sequenceFrameDuration: { value: "1", timescale: "30" }, analysis: { ...input.analysis,
      sourceIdentity: { ...source, duration: 11 }, requestedRange: { start: 0, end: 11 }, observedRange: { start: 0, end: 11 },
      words: [{ text: "happens.", start: 2.24, end: 2.76, confidence: 0.99 }, { text: "The", start: 7.2, end: 7.48, confidence: 0.98 }],
      vadSegments: [{ kind: "speech" as const, start: 0, end: 2.942 }, { kind: "speech" as const, start: 7.394, end: 9.566 }],
    } };
  const plan = rankNarrativeCuts(partial);
  assert.equal(plan.candidates.length, 1);
  const candidate = plan.candidates[0]!;
  assert.ok(candidate.sourceRange.start >= 3.142 && candidate.sourceRange.end <= 7.0);
  assert.ok(candidate.confidence <= 0.5 && candidate.reviewRequired);
  assert.ok(plan.warnings.some((warning) => /partial.*review/i.test(warning)));
  const tooLittleCorroboration = { ...partial, analysis: { ...partial.analysis,
    words: [partial.analysis.words[0]!, { text: "Go", start: 7.2, end: 7.28, confidence: 0.98 }],
    vadSegments: [partial.analysis.vadSegments[0]!, { kind: "speech" as const, start: 7.25, end: 9.566 }],
  } };
  assert.equal(rankNarrativeCuts(tooLittleCorroboration).candidates.length, 0, "very small overlaps must not corroborate speech");
  const protectedInput = { ...partial, analysis: { ...partial.analysis, protectedSegments: [{ kind: "speech" as const, start: 4, end: 5 }] } };
  assert.equal(rankNarrativeCuts(protectedInput).candidates.length, 0);
  const conflicting = { ...partial, analysis: { ...partial.analysis, vadSegments: [partial.analysis.vadSegments[0]!,
    { kind: "speech" as const, start: 4, end: 5 }, partial.analysis.vadSegments[1]!] } };
  assert.equal(rankNarrativeCuts(conflicting).candidates.length, 0);
});
