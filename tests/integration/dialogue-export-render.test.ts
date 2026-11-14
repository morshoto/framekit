import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalCutOccurrenceAudioAnalyzer, type OccurrenceAudioExporter } from "@framekit/final-cut";
import { AgentVideoRuntime, canonicalSnapshotDigest, type AudioAnalyzer } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

// Explicit rendered reference levels, not the planner's arithmetic. This port
// simulates native output; these tests do not establish Final Cut export proof.
function pcm(amplitude: number, spike = false): Buffer {
  const data = Buffer.alloc(44 + 96000 * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < 96000; i++) data.writeInt16LE(Math.round(32767 * amplitude * Math.sin(2 * Math.PI * 1000 * i / 48000)), 44 + i * 2);
  if (spike) data.writeInt16LE(32760, 44 + 48000 * 2);
  return data;
}
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t: test.TestContext, singleOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "framekit-dialogue-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.wav");
  await writeFile(source, pcm(0.1));
  const adapter = new InMemoryEditorAdapter({ projectId: "dialogue", projectName: "Dialogue", timelineId: "sequence", timelineName: "Sequence",
    clips: [{ id: "selected", mediaId: "source", name: "Selected", start: 0, duration: 2, track: 0, gainDb: 2 },
      { id: "duplicate", mediaId: "source", name: "Duplicate", start: 2, duration: 2, track: 0, gainDb: 7 }],
    media: [{ mediaId: "source", source, sourceDigest: digest(await readFile(source)), mediaKind: "audio", duration: 2,
      speech: { words: [{ text: "reference dialogue annotation", start: 0, end: 1, confidence: 1 }] } }],
  });
  if (singleOnly) {
    const capabilities = adapter.getCapabilities.bind(adapter);
    adapter.getCapabilities = async () => {
      const value = await capabilities();
      return { ...value, editor: { ...value.editor, compositeTransactions: false, singleOperationTransactions: true } };
    };
  }
  let postOutput = pcm(0.14125375); // -20 LUFS, -17 dBFS peak, within 0.2 LU/dB.
  let exports = 0;
  const exporter: OccurrenceAudioExporter = {
    descriptor: { id: "reference-export", provider: "simulated-editor", version: "1" },
    export: async ({ binding, outputPath }) => {
      exports++;
      const bytes = binding.gainDb === 2 ? pcm(0.1) : postOutput;
      await writeFile(outputPath, bytes);
      return { binding, outputDigest: digest(bytes) };
    },
  };
  const meter = new FinalCutOccurrenceAudioAnalyzer({ exporter, readSnapshot: () => adapter.readProject(), temporaryRoot: root });
  const analyzer: AudioAnalyzer = { descriptor: meter.descriptor, analyze: (input, range) => meter.analyze(input, range) };
  const runtime = new AgentVideoRuntime(adapter, { audioAnalyzer: analyzer, ...{ requireExportedAudioSignal: true } });
  runtime.registerBuiltinSkills();
  const preview = async (targetLufs = -20) => runtime.previewSkill({ skillId: "dialogue-normalization",
    baseRevision: (await runtime.inspectProject()).revision,
    input: { mediaId: "source", occurrenceId: "selected", targetLufs, toleranceDb: 0.2 } });
  return { root, adapter, exporter, analyzer, meter, runtime, preview, exports: () => exports,
    output: (amplitude: number, spike = false) => { postOutput = pcm(amplitude, spike); } };
}

test("exported audio normalizes one occurrence through guarded single-operation execution and Undo", async t => {
  const f = await fixture(t, true);
  const before = await f.adapter.readProject();
  const preview = await f.preview();
  assert.equal(preview.plan.details?.existingGainDb, 2);
  assert.equal(preview.plan.details?.targetGainDb, 5);
  assert.equal(preview.plan.operations.length, 1);
  assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
  // Caller mutation cannot alter the approved, stored plan.
  Object.assign(preview.plan.operations[0]!, { clipId: "duplicate", gainDb: 30 });
  const result = await f.runtime.executeSkill(preview.previewToken);
  assert.equal(result.status, "VERIFIED");
  assert.equal(f.exports(), 2);
  const after = await f.adapter.readProject();
  assert.equal(after.timeline.clips[0]!.gainDb, 5);
  assert.deepEqual(after.timeline.clips[1], before.timeline.clips[1]);
  assert.equal(result.verification?.checks.find(check => check.name === "dialogue-measurement")?.passed, true);
  await assert.rejects(f.runtime.executeSkill(preview.previewToken), /already used/);
  await f.runtime.undo(result.transactionIds[0]!);
  assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
  assert.deepEqual(await readdir(f.root), ["source.wav"]);
});

test("strict normalization rejects unproven occurrence measurements before preview", async t => {
  const f = await fixture(t);
  f.analyzer.analyze = async input => ({ signalScope: "occurrence", occurrenceId: input.occurrenceId,
    integratedLufs: -23, truePeakDb: -20, silenceMs: 0, dialoguePresent: true });
  const before = await f.adapter.readProject();
  await assert.rejects(f.preview(), /OCCURRENCE_SIGNAL_UNAVAILABLE/);
  assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
});

test("missing, reused or changed post-write evidence restores the original gain", async t => {
  for (const mode of ["missing", "reused-request", "exporter", "meter-version"] as const) {
    const f = await fixture(t);
    let requestId = "";
    let count = 0;
    f.analyzer.analyze = async (input, range) => {
      const measured = await f.meter.analyze(input, range);
      if (++count === 1) requestId = measured.signalProvenance!.requestId;
      else if (mode === "missing") delete measured.signalProvenance;
      else if (mode === "reused-request") measured.signalProvenance!.requestId = requestId;
      else if (mode === "exporter") measured.signalProvenance!.exporter.version = "changed";
      else measured.signalProvenance!.meterVersion = "different meter build";
      return measured;
    };
    const before = await f.adapter.readProject();
    const result = await f.runtime.executeSkill((await f.preview()).previewToken);
    assert.equal(result.status, "ROLLED_BACK", mode);
    assert.equal(result.rollback.succeeded, true);
    assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before), mode);
  }
});

test("actual LUFS or peak failure rolls back even when gain readback is correct", async t => {
  for (const mode of ["loudness", "peak"] as const) {
    const f = await fixture(t);
    f.output(mode === "loudness" ? 0.1 : 0.14125375, mode === "peak");
    const before = await f.adapter.readProject();
    const result = await f.runtime.executeSkill((await f.preview()).previewToken);
    assert.equal(result.status, "ROLLED_BACK", mode);
    assert.equal(result.verification?.checks.find(check => check.name === (mode === "peak" ? "dialogue-true-peak" : "dialogue-loudness"))?.passed, false);
    assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
  }
});

test("NO_OP obtains fresh exported evidence at execution without changing gain", async t => {
  const f = await fixture(t);
  const before = await f.adapter.readProject();
  const preview = await f.preview(-23);
  assert.equal(preview.plan.decision, "NO_OP");
  const result = await f.runtime.executeSkill(preview.previewToken);
  assert.equal(result.status, "VERIFIED");
  assert.equal(f.exports(), 2);
  assert.equal(result.verification?.passed, true);
  assert.deepEqual(result.transactionIds, []);
  assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
});

test("NO_OP cannot verify when its fresh exported signal is unavailable", async t => {
  const f = await fixture(t);
  const before = await f.adapter.readProject();
  const preview = await f.preview(-23);
  f.exporter.export = async () => { throw new Error("OCCURRENCE_SIGNAL_UNAVAILABLE"); };
  const result = await f.runtime.executeSkill(preview.previewToken);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(result.transactionIds, []);
  assert.equal(result.rollback.attempted, false);
  assert.equal(canonicalSnapshotDigest(await f.adapter.readProject()), canonicalSnapshotDigest(before));
});

test("an occurrence already at target but above the peak limit is skipped", async t => {
  const f = await fixture(t);
  const original = f.analyzer.analyze;
  f.analyzer.analyze = async (input, range) => ({ ...await original(input, range), truePeakDb: 0 });
  const preview = await f.preview(-23);
  assert.equal(preview.plan.decision, "SKIP");
  assert.ok(preview.plan.warnings.includes("PEAK_RISK"));
  assert.equal((await f.runtime.executeSkill(preview.previewToken)).status, "SKIPPED");
});
