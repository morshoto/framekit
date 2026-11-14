import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalCutOccurrenceAudioAnalyzer, type OccurrenceAudioExporter } from "@framekit/final-cut";
import { AgentVideoRuntime, canonicalSnapshotDigest, DIALOGUE_NORMALIZATION_DEFAULTS, type AnalysisInput } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

// Analytic 1 kHz PCM reference: amplitude 0.1 has -20 dBFS peak and
// approximately -23 LUFS (mono, no dual-mono compensation). The meter never
// receives the amplitude or computes audio from the canonical gain.
function pcm(amplitude: number, seconds = 2): Buffer {
  const samples = Math.round(48_000 * seconds);
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48_000, 24); data.writeUInt32LE(96_000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(32767 * amplitude * Math.sin(2 * Math.PI * 1000 * i / 48_000)), 44 + 2 * i);
  return data;
}
const digest = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "framekit-occurrence-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.wav");
  await writeFile(source, pcm(0.1, 5));
  const adapter = new InMemoryEditorAdapter({ projectId: "audio-project", projectName: "Audio", timelineId: "audio-sequence", timelineName: "Audio",
    clips: [{ id: "quiet", mediaId: "source", name: "Quiet", sourceStart: 1, sourceStartTime: { value: "24", timescale: "24" }, start: 0, duration: 2, track: 0, gainDb: -6.0206 },
      { id: "loud", mediaId: "source", name: "Loud", sourceStart: 2, sourceStartTime: { value: "48", timescale: "24" }, start: 2, duration: 2, track: 0, gainDb: 6.0206 }],
    media: [{ mediaId: "source", source, sourceDigest: digest(await readFile(source)), duration: 5, mediaKind: "audio" }],
  });
  let current = await adapter.readProject();
  const requests: string[] = [];
  const exporter: OccurrenceAudioExporter = {
    descriptor: { id: "fixture.export", provider: "simulated-final-cut", version: "1" },
    export: async ({ binding, outputPath }) => {
      requests.push(binding.requestId);
      const bytes = pcm(binding.occurrenceId === "quiet" ? 0.05 : 0.2);
      await writeFile(outputPath, bytes);
      return { binding: structuredClone(binding), outputDigest: digest(bytes) };
    },
  };
  const input = (id = "quiet"): AnalysisInput => ({ project: structuredClone(current), media: structuredClone(current.media[0]!), occurrenceId: id });
  const analyzer = () => new FinalCutOccurrenceAudioAnalyzer({ exporter, readSnapshot: async () => structuredClone(current), temporaryRoot: root });
  return { root, source, adapter, exporter, input, analyzer, requests,
    drift: () => { current.timeline.clips[0]!.gainDb = 1; },
    driftSourceIdentity: () => { current.media[0]!.sourceDigest = `sha256:${"0".repeat(64)}`; } };
}

test("isolated export measurement attributes real PCM levels to trimmed repeated occurrences", async (t) => {
  const f = await fixture(t);
  const before = canonicalSnapshotDigest(f.input().project);
  const meter = f.analyzer();
  for (const [id, lufs, peak, range] of [
    ["quiet", -29.0, -26.0, { start: 1, end: 3 }],
    ["loud", -17.0, -14.0, { start: 2, end: 4 }],
  ] as const) {
    const result = await meter.analyze(f.input(id), range);
    assert.equal(result.valid, true);
    assert.ok(Math.abs(result.integratedLufs - lufs) <= 0.2, JSON.stringify(result));
    assert.ok(Math.abs(result.truePeakDb - peak) <= 0.2);
    assert.equal(result.occurrenceId, id);
    assert.equal(result.signalScope, "occurrence");
    assert.equal(result.measuredRange?.start, range.start);
    assert.equal(result.measuredRange?.end, range.end);
    assert.deepEqual(result.measuredRange?.startTime, f.input(id).project.timeline.clips.find(c => c.id === id)!.sourceStartTime);
    assert.deepEqual(result.measuredRange?.durationTime, f.input(id).project.timeline.clips.find(c => c.id === id)!.durationTime);
    assert.equal(result.signalProvenance?.scope, "isolated-occurrence");
    assert.equal(result.signalProvenance?.origin, "editor-export");
    assert.match(result.signalProvenance?.outputDigest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(result.signalProvenance?.meterVersion ?? "", /ffmpeg version/);
    assert.equal(result.signalProvenance?.sampleRate, 48000);
    assert.equal(result.signalProvenance?.sampleCount, 96000);
    assert.equal(result.signalProvenance?.gainDb, f.input(id).project.timeline.clips.find(c => c.id === id)!.gainDb);
  }
  await meter.analyze(f.input(), { start: 1, end: 3 });
  assert.equal(new Set(f.requests).size, 3, "every measurement obtains fresh exported bytes");
  assert.equal(canonicalSnapshotDigest(f.input().project), before);
  assert.equal(digest(await readFile(f.source)), f.input().media.sourceDigest);
  assert.deepEqual(await readdir(f.root), ["source.wav"], "owned output is removed");
  const runtime = new AgentVideoRuntime(f.adapter, { audioAnalyzer: meter });
  const bound = await runtime.previewDialogueNormalization({ ...DIALOGUE_NORMALIZATION_DEFAULTS, mediaId: "source", occurrenceId: "quiet", baseRevision: f.input().project.revision });
  assert.equal(bound.measurement.signalProvenance?.scope, "isolated-occurrence", "runtime preserves measured-signal evidence");
});

test("occurrence measurement has no source-file or unbound-export fallback", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new FinalCutOccurrenceAudioAnalyzer({ readSnapshot: async () => f.input().project }).analyze(f.input()), /OCCURRENCE_SIGNAL_UNAVAILABLE/);
  await assert.rejects(f.analyzer().analyze({ ...f.input(), occurrenceId: undefined }), /OCCURRENCE_SIGNAL_UNAVAILABLE/);
  await assert.rejects(f.analyzer().analyze(f.input(), { start: 1, end: 2 }), /RANGE_MISMATCH/);
  const input = f.input(); input.project.timeline.clips[0]!.noiseReductionDb = 3;
  await assert.rejects(f.analyzer().analyze(input), /UNSUPPORTED_PROCESSING/);
  assert.deepEqual(f.requests, []);
});

test("mismatched receipt and source bytes never become occurrence evidence", async (t) => {
  for (const field of ["requestId", "scope", "origin", "projectId", "sequenceId", "occurrenceId", "sourceIdentity", "canonicalDigest", "gainDb", "effectScope", "sourceRange", "sequenceRange", "revision", "outputDigest"] as const) {
    const f = await fixture(t);
    const original = f.exporter.export;
    f.exporter.export = async request => {
      const receipt = await original(request);
      if (field === "outputDigest") receipt.outputDigest = `sha256:${"0".repeat(64)}`;
      else Object.assign(receipt.binding, { [field]: field === "gainDb" ? 99 : "wrong" });
      return receipt;
    };
    await assert.rejects(f.analyzer().analyze(f.input()), /SIGNAL_BINDING_MISMATCH|OUTPUT_CHANGED/, field);
    assert.deepEqual(await readdir(f.root), ["source.wav"]);
  }
});

test("source replacement and canonical drift during export invalidate the result", async (t) => {
  for (const drift of ["source", "canonical", "registered-source"]) {
    const f = await fixture(t);
    const original = f.exporter.export;
    f.exporter.export = async request => {
      const result = await original(request);
      if (drift === "source") await writeFile(f.source, pcm(0.2, 5));
      else if (drift === "registered-source") f.driftSourceIdentity();
      else f.drift();
      return result;
    };
    await assert.rejects(f.analyzer().analyze(f.input()), /SOURCE_CHANGED|ANALYSIS_STALE/);
    assert.deepEqual(await readdir(f.root), ["source.wav"]);
  }
});

test("silence and short exported signals cannot supply valid measurements", async (t) => {
  for (const [amplitude, seconds, reason] of [[0, 2, "SILENT_SIGNAL"], [0.1, 0.2, "INSUFFICIENT_DURATION"]] as const) {
    const f = await fixture(t);
    const input = f.input();
    if (seconds < 1) {
      input.project.timeline.clips[0]!.duration = seconds;
      input.project.timeline.clips[0]!.durationTime = { value: "1", timescale: "5" };
    }
    f.exporter.export = async ({ binding, outputPath }) => {
      const bytes = pcm(amplitude, seconds); await writeFile(outputPath, bytes);
      return { binding: structuredClone(binding), outputDigest: digest(bytes) };
    };
    const analyzer = new FinalCutOccurrenceAudioAnalyzer({ exporter: f.exporter, readSnapshot: async () => structuredClone(input.project), temporaryRoot: f.root });
    if (amplitude === 0) await assert.rejects(analyzer.analyze(input), /SILENT_SIGNAL/);
    else {
      const result = await analyzer.analyze(input);
      assert.equal(result.valid, false);
      assert.equal(result.invalidReason, reason);
    }
    assert.deepEqual(await readdir(f.root), ["source.wav"]);
  }
});

test("malformed output and terminal export timeout clean owned artifacts", async (t) => {
  const f = await fixture(t);
  f.exporter.export = async ({ binding, outputPath }) => {
    const bytes = Buffer.from("not audio"); await writeFile(outputPath, bytes);
    return { binding: structuredClone(binding), outputDigest: digest(bytes) };
  };
  await assert.rejects(f.analyzer().analyze(f.input()), /AUDIO_OUTPUT_INVALID/);
  f.exporter.export = async ({ outputPath, signal }) => {
    await writeFile(outputPath, "partial export");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("export cancelled and terminal");
  };
  const timed = new FinalCutOccurrenceAudioAnalyzer({ exporter: f.exporter, readSnapshot: async () => f.input().project, temporaryRoot: f.root, timeoutMs: 20 });
  await assert.rejects(timed.analyze(f.input()), /OCCURRENCE_SIGNAL_TIMEOUT/);
  assert.deepEqual(await readdir(f.root), ["source.wav"]);
});

test("meter preserves fractional source coordinates and uses bytes rather than gain metadata", async (t) => {
  const f = await fixture(t);
  const input = f.input();
  const clip = input.project.timeline.clips[0]!;
  clip.sourceStartTime = { value: "24024", timescale: "24000" };
  clip.durationTime = { value: "48048", timescale: "24000" };
  clip.gainDb = 12;
  // Convenience seconds deliberately disagree; exact canonical timing wins.
  clip.sourceStart = 1; clip.duration = 2;
  f.exporter.export = async ({ binding, outputPath }) => {
    const bytes = pcm(0.1, 2.002); await writeFile(outputPath, bytes);
    return { binding: structuredClone(binding), outputDigest: digest(bytes) };
  };
  const meter = new FinalCutOccurrenceAudioAnalyzer({ exporter: f.exporter, readSnapshot: async () => structuredClone(input.project), temporaryRoot: f.root });
  const result = await meter.analyze(input);
  assert.deepEqual(result.measuredRange?.startTime, clip.sourceStartTime);
  assert.deepEqual(result.measuredRange?.durationTime, clip.durationTime);
  assert.equal(result.analyzedDurationSeconds, 2.002);
  assert.equal(result.signalProvenance?.sampleCount, 96096);
  assert.ok(Math.abs(result.integratedLufs + 23) <= 0.2);
  assert.ok(Math.abs(result.truePeakDb + 20) <= 0.2);
});

test("output cleanup waits for exporter termination after timeout", async (t) => {
  const f = await fixture(t);
  let finish!: () => void;
  let aborted!: () => void;
  const sawAbort = new Promise<void>(resolve => { aborted = resolve; });
  const terminal = new Promise<void>(resolve => { finish = resolve; });
  f.exporter.export = async ({ outputPath, signal }) => {
    signal.addEventListener("abort", aborted, { once: true });
    await terminal;
    await writeFile(outputPath, "last write before terminal cancellation");
    throw new Error("terminal cancellation");
  };
  const meter = new FinalCutOccurrenceAudioAnalyzer({ exporter: f.exporter, readSnapshot: async () => f.input().project, temporaryRoot: f.root, timeoutMs: 20 });
  const result = meter.analyze(f.input());
  await sawAbort;
  assert.equal((await readdir(f.root)).length, 2, "abort is not proof that the output writer stopped");
  finish();
  await assert.rejects(result, /OCCURRENCE_SIGNAL_TIMEOUT/);
  assert.deepEqual(await readdir(f.root), ["source.wav"]);
});

test("wrong duration and oversized output are rejected before accepting metrics", async (t) => {
  const f = await fixture(t);
  f.exporter.export = async ({ binding, outputPath }) => {
    const bytes = pcm(0.1, 1); await writeFile(outputPath, bytes);
    return { binding: structuredClone(binding), outputDigest: digest(bytes) };
  };
  await assert.rejects(f.analyzer().analyze(f.input()), /AUDIO_OUTPUT_INVALID.*duration/);
  const bounded = new FinalCutOccurrenceAudioAnalyzer({ exporter: f.exporter, readSnapshot: async () => f.input().project, temporaryRoot: f.root, maxOutputBytes: 1024 });
  await assert.rejects(bounded.analyze(f.input()), /AUDIO_OUTPUT_INVALID.*limit/);
  assert.deepEqual(await readdir(f.root), ["source.wav"]);
});

test("runtime rejects stale exported-signal provenance instead of rebinding it", async (t) => {
  const f = await fixture(t);
  const meter = f.analyzer();
  const measured = await meter.analyze(f.input());
  for (const field of ["projectId", "sequenceId", "canonicalDigest", "gainDb", "outputDigest", "exporter", "meterVersion", "sampleCount", "sampleRate"] as const) {
    const altered = structuredClone(measured);
    Object.assign(altered.signalProvenance!, { [field]: field === "gainDb" ? 20 : "wrong" });
    const runtime = new AgentVideoRuntime(f.adapter, { audioAnalyzer: { descriptor: meter.descriptor, analyze: async () => altered } });
    if (field === "meterVersion") altered.signalProvenance!.meterVersion = "";
    await assert.rejects(runtime.previewDialogueNormalization({ ...DIALOGUE_NORMALIZATION_DEFAULTS,
      mediaId: "source", occurrenceId: "quiet", baseRevision: f.input().project.revision }), /ANALYSIS_INVALID.*signal provenance/, field);
  }
});
