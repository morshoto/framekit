import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySemanticMediaIndexStore } from "../../../packages/runtime/src/application/semantic-media-index-store.js";
import { InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyAnalysisEvidence } from "../../../packages/runtime/src/planning/analysis-evidence.js";
import type { MediaUnderstanding } from "../../../packages/runtime/src/domain/media.js";

const source = { mediaId: "m1", source: "fixture.mov", sourceDigest: "sha256:source", mediaKind: "video" as const, duration: 10 };
const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const provider = { id: "speech", provider: "fixture", version: "1", model: "model", configurationDigest: "sha256:config" };
const range = { start: 1, end: 4 };
const understanding: MediaUnderstanding = {
  mediaId: source.mediaId, source: source.source, sourceIdentity: source, analysisRevision: revision,
  semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
  analysis: [{ capability: "speech", status: "analyzed", provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }],
  speech: { schemaVersion: 1, mediaId: source.mediaId, sourceIdentity: source, revision, provider, requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-plus-vad", words: [{ text: "hello", start: 1, end: 2, confidence: 0.9 }], vadSegments: [{ kind: "speech", start: 1, end: 2 }] },
};
const fixtureVerifier = async () => {};
const context = { kind: "speech" as const, source, provider, revision, range };

async function fixture(record = understanding) {
  const index = new InMemorySemanticMediaIndexStore();
  await index.save(record);
  return { index, artifacts: new InMemoryAnalysisArtifactStore() };
}

test("pin and verify an existing stored analysis without changing the index", async () => {
  const { index, artifacts } = await fixture();
  const before = await index.list();
  const ref = await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier);
  assert.deepEqual(await index.list(), before);
  assert.deepEqual(await verifyAnalysisEvidence(artifacts, ref, context, fixtureVerifier), { status: "verified" });
  assert.deepEqual(await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier), ref);
});

test("missing, stale, partial and conflicting analysis fail closed", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier);
  for (const changed of [
    { source: { ...source, sourceDigest: "sha256:other" } },
    { provider: { ...provider, configurationDigest: "sha256:other" } },
    { revision: { ...revision, sequence: 2 } },
    { range: { start: 1, end: 11 } },
  ]) assert.notEqual((await verifyAnalysisEvidence(artifacts, ref, { ...context, ...changed }, fixtureVerifier)).status, "verified");
  const missing = new InMemoryAnalysisArtifactStore();
  assert.equal((await verifyAnalysisEvidence(missing, ref, context, fixtureVerifier)).status, "unavailable");
  const partial = await fixture({ ...understanding, speech: { ...understanding.speech!, observedRange: { start: 0, end: 2 } } });
  await assert.rejects(() => pinAnalysisEvidence(partial.index, partial.artifacts, context, fixtureVerifier), /ANALYSIS_/);
  const conflict = await fixture({ ...understanding, speech: { ...understanding.speech!, provider: { ...provider, model: "other" } } });
  await assert.rejects(() => pinAnalysisEvidence(conflict.index, conflict.artifacts, context, fixtureVerifier), /ANALYSIS_/);
});

test("changed stored artifact bytes cannot pass the approved reference", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier);
  const tampered = { get: async () => Buffer.from('{"tampered":true}'), put: async () => {} };
  assert.equal((await verifyAnalysisEvidence(tampered, ref, context, fixtureVerifier)).status, "invalid");
});

test("VAD requires complete available segments and audio requires measured source evidence", async () => {
  const { index, artifacts } = await fixture();
  const vadContext = { ...context, kind: "vad" as const };
  const ref = await pinAnalysisEvidence(index, artifacts, vadContext, fixtureVerifier);
  assert.equal((await verifyAnalysisEvidence(artifacts, ref, vadContext, fixtureVerifier)).status, "verified");
  const noVad = await fixture({ ...understanding, speech: { ...understanding.speech!, capability: "transcription-only", vadSegments: undefined } });
  await assert.rejects(() => pinAnalysisEvidence(noVad.index, noVad.artifacts, vadContext, fixtureVerifier), /ANALYSIS_/);
  const { model: _model, ...audioProvider } = provider;
  const audio = { mediaId: source.mediaId, sourceIdentity: source, provider: audioProvider, revision, requestedRange: { start: 0, end: 10 }, measuredRange: { start: 0, end: 10 }, integratedLufs: -20, truePeakDb: -2, silenceMs: 10, valid: true };
  const audioRecord: MediaUnderstanding = { ...understanding, audio, analysis: [{ capability: "audio", status: "analyzed", provenance: { source, analyzer: audioProvider, ranges: [{ start: 0, end: 10 }] } }] };
  const audioFixture = await fixture(audioRecord);
  const audioContext = { ...context, kind: "audio" as const, provider: audioProvider };
  const audioRef = await pinAnalysisEvidence(audioFixture.index, audioFixture.artifacts, audioContext, fixtureVerifier);
  assert.equal((await verifyAnalysisEvidence(audioFixture.artifacts, audioRef, audioContext, fixtureVerifier)).status, "verified");
  const invalid = await fixture({ ...audioRecord, audio: { ...audio, valid: false } });
  await assert.rejects(() => pinAnalysisEvidence(invalid.index, invalid.artifacts, audioContext, fixtureVerifier), /ANALYSIS_/);
});

test("exact timing changes and contradictory rational ranges are rejected", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier);
  const altered = { ...context, range: { ...range, startTime: { value: "1", timescale: "1" } } };
  assert.notEqual((await verifyAnalysisEvidence(artifacts, ref, altered, fixtureVerifier)).status, "verified");
  await assert.rejects(() => pinAnalysisEvidence(index, artifacts, { ...context, range: { ...range, startTime: { value: "2", timescale: "1" } } }, fixtureVerifier), /ANALYSIS_/);
});

test("content-addressed artifacts survive restart and detect corrupt stored bytes", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileAnalysisArtifactStore } = await import("../../../packages/runtime/src/planning/analysis-evidence.js");
  const directory = await mkdtemp(join(tmpdir(), "framekit-evidence-"));
  try {
    const { index } = await fixture();
    const ref = await pinAnalysisEvidence(index, new FileAnalysisArtifactStore(directory), context, fixtureVerifier);
    const reopened = new FileAnalysisArtifactStore(directory);
    assert.equal((await verifyAnalysisEvidence(reopened, ref, context, fixtureVerifier)).status, "verified");
    await writeFile(join(directory, ref.artifactDigest.slice(7)), "corrupted");
    assert.equal((await verifyAnalysisEvidence(reopened, ref, context, fixtureVerifier)).status, "invalid");
    await assert.rejects(() => pinAnalysisEvidence(index, reopened, context, fixtureVerifier), /ANALYSIS_/);
    await assert.rejects(() => reopened.get("../../unsafe"), /ANALYSIS_/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("current source bytes are revalidated when pinning and verifying", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { verifyLocalMediaSource } = await import("../../../packages/runtime/src/application/local-media.js");
  const dir = await mkdtemp(join(tmpdir(), "framekit-source-"));
  try {
    const path = join(dir, "media.mov");
    await writeFile(path, "original");
    const localSource = { ...source, source: path, sourceDigest: createHash("sha256").update("original").digest("hex") };
    const localRecord = structuredClone(understanding);
    localRecord.source = path;
    localRecord.sourceIdentity = localSource;
    localRecord.analysis[0]!.provenance!.source = localSource;
    localRecord.speech!.sourceIdentity = localSource;
    const localContext = { ...context, source: localSource };
    const { index, artifacts } = await fixture(localRecord);
    const ref = await pinAnalysisEvidence(index, artifacts, localContext, verifyLocalMediaSource);
    assert.equal((await verifyAnalysisEvidence(artifacts, ref, localContext, verifyLocalMediaSource)).status, "verified");
    await writeFile(path, "replaced");
    assert.notEqual((await verifyAnalysisEvidence(artifacts, ref, localContext, verifyLocalMediaSource)).status, "verified");
    await assert.rejects(() => pinAnalysisEvidence(index, artifacts, localContext, verifyLocalMediaSource), /MEDIA_CHANGED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("command speech analyzer exposes its declared model identity", async () => {
  const { CommandSpeechAnalyzer } = await import("../../../adapters/final-cut/typescript/src/analyzers.js");
  const a = new CommandSpeechAnalyzer({ command: "fixture", providerVersion: "1", modelIdentity: "model@sha256:a", environment: {} });
  const b = new CommandSpeechAnalyzer({ command: "fixture", providerVersion: "1", modelIdentity: "model@sha256:b", environment: {} });
  assert.equal(a.descriptor.model, "model@sha256:a");
  assert.notEqual(a.descriptor.configurationDigest, b.descriptor.configurationDigest);
});

test("source verification is required and brackets evidence access", async () => {
  const { index, artifacts } = await fixture();
  await assert.rejects(() => pinAnalysisEvidence(index, artifacts, context, undefined as never), /ANALYSIS_UNAVAILABLE/);
  const ref = await pinAnalysisEvidence(index, artifacts, context, fixtureVerifier);
  assert.equal((await verifyAnalysisEvidence(artifacts, ref, context, undefined as never)).status, "unavailable");
  let calls = 0;
  const changedDuringRead = async () => { if (++calls === 2) throw new Error("source changed"); };
  assert.equal((await verifyAnalysisEvidence(artifacts, ref, context, changedDuringRead)).status, "invalid");
});

test("command analysis can be pinned from the persisted semantic index", async () => {
  const { mkdtemp, rm, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { CommandSpeechAnalyzer } = await import("../../../adapters/final-cut/typescript/src/analyzers.js");
  const { AgentVideoRuntime, JsonSemanticMediaIndexStore, verifyLocalMediaSource } = await import("../../../packages/runtime/src/index.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const dir = await mkdtemp(join(tmpdir(), "framekit-evidence-provider-"));
  try {
    const mediaPath = join(dir, "source.wav");
    await writeFile(mediaPath, "media");
    const command = join(dir, "provider.mjs");
    await writeFile(command, `#!/usr/bin/env node\nfor await (const _ of process.stdin) {}\nprocess.stdout.write(JSON.stringify({words:[{text:'hello',start:1,end:2,confidence:0.9}],vadSegments:[{kind:'speech',start:1,end:2}],sourceTimebase:{value:'1',timescale:'1000'}}));\n`);
    await chmod(command, 0o755);
    const media = { mediaId: "media-1", source: mediaPath, sourceDigest: createHash("sha256").update("media").digest("hex"), mediaKind: "audio" as const, duration: 10 };
    const adapter = new InMemoryEditorAdapter({ projectId: "p", projectName: "p", timelineId: "t", timelineName: "t", clips: [], media: [media] });
    const analyzer = new CommandSpeechAnalyzer({ command, providerVersion: "fixture-v1", modelIdentity: "fixture-model-v1" });
    const index = new JsonSemanticMediaIndexStore(join(dir, "index.json"));
    const runtime = new AgentVideoRuntime(adapter, { speechAnalyzer: analyzer, semanticMediaIndexStore: index });
    const result = await runtime.understandMedia(media.mediaId);
    assert.equal(result.analysis.find((entry) => entry.capability === "speech")?.status, "analyzed");
    assert.deepEqual(result.analysis.find((entry) => entry.capability === "speech")?.provenance?.ranges, [{ start: 0, end: 10 }]);
    const artifactContext = { kind: "vad" as const, source: media, provider: analyzer.descriptor, revision: result.analysisRevision, range: { start: 1, end: 3 } };
    const artifacts = new InMemoryAnalysisArtifactStore();
    const ref = await pinAnalysisEvidence(index, artifacts, artifactContext, verifyLocalMediaSource);
    assert.equal((await verifyAnalysisEvidence(artifacts, ref, artifactContext, verifyLocalMediaSource)).status, "verified");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
