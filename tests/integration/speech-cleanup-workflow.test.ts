import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, canonicalSnapshotDigest, type SpeechAnalyzer } from "@framekit/runtime";
import { FinalCutOccurrenceAudioAnalyzer } from "@framekit/final-cut";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

// Controlled speech/export ports exercise production MCP/runtime with actual PCM
// metering. They do not observe Final Cut or establish native speech/export proof.
function pcm(seconds: number, amplitude: number) {
  const frames = Math.round(seconds * 48000); const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(32767 * amplitude * Math.sin(2 * Math.PI * 1000 * i / 48000)), 44 + i * 2);
  return bytes;
}
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture(t: test.TestContext, failOutput = false, multipleCuts = false) {
  const directory = await mkdtemp(join(tmpdir(), "framekit-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "speech.wav"); const bytes = pcm(4, 0.1); await writeFile(source, bytes);
  const words = [{ text: "hello", start: 0.2, end: 0.6, confidence: 0.99 },
    { text: "um", start: 1, end: 1.3, confidence: 0.99, filler: true },
    { text: "world", start: 1.6, end: 2.2, confidence: 0.99 }];
  if (multipleCuts) words.push({ text: "uh", start: 2.5, end: 2.8, confidence: 0.99, filler: true },
    { text: "end", start: 3.2, end: 3.6, confidence: 0.99 });
  const adapter = new InMemoryEditorAdapter({ projectId: "cleanup", projectName: "Cleanup", timelineId: "sequence", timelineName: "Sequence",
    frameDuration: { value: "1001", timescale: "24000" },
    clips: [{ id: "selected", mediaId: "speech", name: "Selected", start: 0, duration: 4, track: 0, gainDb: 0 },
      { id: "reused", mediaId: "speech", name: "Reused", start: 4, duration: 4, track: 0, gainDb: 0 }],
    media: [{ mediaId: "speech", source, sourceDigest: digest(bytes), mediaKind: "audio", duration: 4, speech: { words } }] });
  const speech: SpeechAnalyzer = { descriptor: { id: "controlled-speech", provider: "test", version: "1" }, capabilities: { transcription: true, vad: true },
    analyze: async ({ project }, range) => {
      const selected = project.timeline.clips.find(clip => clip.id === "selected");
      const edited = !selected || selected.duration < 4;
      const observed = words.filter(word => (!edited || !word.filler) && (!range || word.start >= range.start && word.end <= range.end));
      return { words: observed, vadSegments: observed.map(word => ({ start: word.start, end: word.end, kind: "speech" as const })) };
    } };
  let exports = 0; let writes = 0;
  const apply = adapter.applyTransaction.bind(adapter);
  adapter.applyTransaction = async (...args) => { writes++; await apply(...args); };
  const audio = new FinalCutOccurrenceAudioAnalyzer({ readSnapshot: () => adapter.readProject(), temporaryRoot: directory,
    exporter: { descriptor: { id: "controlled-export", provider: "test", version: "1" }, export: async ({ binding, outputPath }) => {
      exports++;
      const bytes = pcm(binding.sourceRange.end - binding.sourceRange.start, binding.gainDb === 0 || failOutput ? 0.1 : 0.14125375);
      await writeFile(outputPath, bytes); return { binding, outputDigest: digest(bytes) };
    } } });
  const runtime = new AgentVideoRuntime(adapter, { speechAnalyzer: speech, audioAnalyzer: audio, requireExportedAudioSignal: true });
  const server = createMcpServer(runtime); const client = new Client({ name: "cleanup-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(item => item.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text);
    return JSON.parse(text as string);
  };
  const inspect = () => call("project.inspect");
  const normalize = async (occurrenceId = "selected") => call("skill.preview", { skill: "dialogue-normalization", arguments: {
    baseRevision: (await inspect()).revision, mediaId: "speech", occurrenceId, targetLufs: -20, toleranceDb: 0.2 } });
  return { adapter, audio, runtime, call, inspect, normalize, writes: () => writes, exports: () => exports };
}

for (const failOutput of [false, true]) test(`filler then measured normalization ${failOutput ? "recovers its stage" : "verifies"} and restores both stages`, async t => {
  const f = await fixture(t, failOutput); const original = await f.inspect();
  const old = await f.normalize();
  const filler = await f.call("skill.preview", { skill: "filler-removal", arguments: { baseRevision: original.revision, range: { start: 0, end: 4 } } });
  const candidates = filler.plan.details.candidates;
  assert.equal(candidates.length, 1);
  const approved = await f.call("skill.preview", { skill: "filler-removal", arguments: { baseRevision: original.revision, range: { start: 0, end: 4 }, selectedCandidateIds: [candidates[0].id] } });
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(original));
  const removal = await f.call("skill.execute", { previewToken: approved.previewToken });
  assert.equal(removal.status, "VERIFIED", JSON.stringify(removal.verification));
  const cut = await f.inspect(); const count = f.writes(); const exports = f.exports();
  assert.notEqual(cut.revision.id, original.revision.id);
  assert.ok(cut.timeline.duration < original.timeline.duration);
  await assert.rejects(f.call("skill.execute", { previewToken: old.previewToken }), /STALE_CONTEXT/);
  assert.equal(f.writes(), count); assert.equal(f.exports(), exports);
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(cut));
  const fresh = await f.normalize();
  assert.equal(fresh.plan.details.measurement.revision.id, cut.revision.id);
  assert.notEqual(fresh.plan.details.measurement.signalProvenance.requestId, old.plan.details.measurement.signalProvenance.requestId);
  assert.ok(fresh.plan.details.measurement.requestedRange.end < old.plan.details.measurement.requestedRange.end);
  const normalization = await f.call("skill.execute", { previewToken: fresh.previewToken });
  assert.equal(normalization.status, failOutput ? "ROLLED_BACK" : "VERIFIED");
  const final = await f.inspect();
  assert.deepEqual(final.timeline.clips.find((clip: any) => clip.id === "reused"), cut.timeline.clips.find((clip: any) => clip.id === "reused"));
  if (!failOutput) await f.call("edit.undo", { transactionId: normalization.transactionIds[0] });
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(cut));
  await f.call("edit.undo", { transactionId: removal.transactionIds[0] });
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(original));
});


test("source-preserving remap rejects old occurrence context and cached measurements", async t => {
  const f = await fixture(t); const original = await f.inspect(); const old = await f.normalize();
  const frame = 1001 / 24000; const range = { start: 23 * frame, end: 32 * frame };
  const time = (seconds: number) => ({ value: String(Math.round(seconds * 24000)), timescale: "24000" });
  // Controlled provider readback of a source-preserving split. This is not the
  // production native split implementation or edited-speech verification.
  const remapped = structuredClone(original);
  const selected = remapped.timeline.clips.find((clip: any) => clip.id === "selected");
  const clip = (id: string, start: number, sourceStart: number, duration: number) => ({ ...selected, id, start, sourceStart, duration,
    startTime: time(start), sourceStartTime: time(sourceStart), durationTime: time(duration) });
  remapped.timeline.clips = [clip("selected-left", 0, 0, range.start), clip("selected-right", range.start, range.end, 4 - range.end),
    { ...remapped.timeline.clips[1], start: 4 - (range.end - range.start), startTime: time(4 - (range.end - range.start)) }];
  remapped.timeline.storyElements = remapped.timeline.clips.map((item: any) => ({ ...original.timeline.storyElements[0], ...item, kind: "asset-clip" }));
  remapped.timeline.duration -= range.end - range.start; remapped.timeline.durationTime = time(remapped.timeline.duration);
  const preview = f.adapter.previewTransaction.bind(f.adapter); const apply = f.adapter.applyTransaction.bind(f.adapter);
  f.adapter.previewTransaction = async (operations, revision) => operations[0]?.type === "ripple-delete" ? structuredClone(remapped) : preview(operations, revision);
  f.adapter.applyTransaction = async (operations, revision) => {
    if (operations[0]?.type === "ripple-delete") await f.adapter.restore(remapped, revision);
    else await apply(operations, revision);
  };
  const cutPreview = await f.runtime.previewEdit({ baseRevision: original.revision, operations: [{ type: "ripple-delete", timelineId: original.timeline.id, range }] });
  const cut = await f.runtime.executeEdit(cutPreview.previewToken); assert.equal(cut.status, "VERIFIED");
  const intermediate = await f.inspect();
  await assert.rejects(f.call("skill.execute", { previewToken: old.previewToken }), /STALE_CONTEXT/);
  const exports = f.exports();
  await assert.rejects(f.normalize(), /OCCURRENCE_NOT_FOUND/);
  assert.equal(f.exports(), exports);
  const analyze = f.audio.analyze.bind(f.audio);
  f.audio.analyze = async () => structuredClone(old.plan.details.measurement);
  await assert.rejects(f.normalize("selected-right"), /ANALYSIS_INVALID|ANALYSIS_STALE|TARGET_MISMATCH/);
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(intermediate));
  f.audio.analyze = analyze;
  const fresh = await f.normalize("selected-right");
  assert.equal(fresh.plan.details.measurement.occurrenceId, "selected-right");
  assert.ok(Math.abs(fresh.plan.details.measurement.measuredRange.start - range.end) < 1e-6);
  assert.equal(fresh.plan.details.measurement.measuredRange.end, 4);
  assert.equal(fresh.plan.normalizedInput.targetLufs, -20);
  assert.equal(fresh.plan.normalizedInput.toleranceDb, 0.2);
  const gain = await f.call("skill.execute", { previewToken: fresh.previewToken }); assert.equal(gain.status, "VERIFIED");
  const normalized = await f.inspect();
  assert.deepEqual(normalized.timeline.clips.filter((item: any) => item.id !== "selected-right"), intermediate.timeline.clips.filter((item: any) => item.id !== "selected-right"));
  await f.call("edit.undo", { transactionId: gain.transactionIds[0] });
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(intermediate));
  await f.call("edit.undo", { transactionId: cut.id });
  assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(original));
});

function sourcePreservingEditor(f: Awaited<ReturnType<typeof fixture>>, original: any, fault?: string) {
  const preview = f.adapter.previewTransaction.bind(f.adapter);
  const apply = f.adapter.applyTransaction.bind(f.adapter);
  const time = (seconds: number) => ({ value: String(Math.round(seconds * 24000)), timescale: "24000" });
  const split = (cuts: Array<{ start: number; end: number }>) => {
    const result = structuredClone(original);
    const selected = result.timeline.clips[0];
    const clip = (id: string, start: number, sourceStart: number, duration: number) => ({ ...selected, id, start, sourceStart, duration,
      startTime: time(start), sourceStartTime: time(sourceStart), durationTime: time(duration) });
    // Build the controlled editor's retained source segments independently of
    // the runtime verifier. All approved cuts are in descending timeline order.
    let sourceRanges = [{ start: 0, end: 4 }];
    for (const range of cuts) sourceRanges = sourceRanges.flatMap(piece => range.end <= piece.start || range.start >= piece.end ? [piece] : [
      ...(piece.start < range.start ? [{ start: piece.start, end: range.start }] : []),
      ...(range.end < piece.end ? [{ start: range.end, end: piece.end }] : []),
    ]);
    let position = 0;
    const pieces = sourceRanges.map((range, index) => {
      const id = index === 0 ? (fault === "retained-id" ? "selected" : "selected-left") : index === sourceRanges.length - 1 ? "selected-right" : `selected-middle-${index}`;
      const item = clip(id, position, range.start, range.end - range.start);
      position += item.duration;
      return item;
    });
    const right = pieces[pieces.length - 1]!;
    if (fault === "rational-source-mismatch") right.sourceStartTime = time(right.sourceStart - 0.2);
    if (fault === "wrong-source") { right.sourceStart -= 0.2; right.sourceStartTime = time(right.sourceStart); }
    if (fault === "missing-piece") pieces.pop();
    if (fault === "ambiguous-piece") pieces.push({ ...right, id: "duplicate-right" });
    if (fault === "unexpected-piece") pieces.push(clip("unexpected", 0.1, 0.1, 0.1));
    result.timeline.clips = [...pieces, { ...result.timeline.clips[1], start: position, startTime: time(position) }];
    result.timeline.storyElements = result.timeline.clips.map((item: any) => ({ ...original.timeline.storyElements[0], ...item, kind: "asset-clip" }));
    result.timeline.duration = position + 4; result.timeline.durationTime = time(result.timeline.duration);
    return result;
  };
  f.adapter.previewTransaction = async (operations, revision) => operations[0]?.type === "ripple-delete" ? split(operations.map(operation => { assert.equal(operation.type, "ripple-delete"); return (operation as Extract<typeof operation, { type: "ripple-delete" }>).range; })) : preview(operations, revision);
  f.adapter.applyTransaction = async (operations, revision) => {
    if (operations[0]?.type === "ripple-delete") await f.adapter.restore(split(operations.map(operation => { assert.equal(operation.type, "ripple-delete"); return (operation as Extract<typeof operation, { type: "ripple-delete" }>).range; })), revision);
    else await apply(operations, revision);
  };
}

for (const fault of [undefined, "retained-id", "multiple-cuts", "wrong-source", "missing-piece", "ambiguous-piece", "unexpected-piece", "rational-source-mismatch"]) {
  test(`full filler Skill validates source-preserving split: ${fault ?? "valid mapping"}`, async t => {
    const invalid = fault !== undefined && fault !== "retained-id" && fault !== "multiple-cuts";
    const f = await fixture(t, false, fault === "multiple-cuts"); const original = await f.inspect();
    sourcePreservingEditor(f, original, fault);
    const args = { baseRevision: original.revision, range: { start: 0, end: 4 } };
    const preview = await f.call("skill.preview", { skill: "filler-removal", arguments: args });
    const approved = await f.call("skill.preview", { skill: "filler-removal", arguments: { ...args, selectedCandidateIds: preview.plan.details.candidates.map((candidate: any) => candidate.id) } });
    const cut = await f.call("skill.execute", { previewToken: approved.previewToken });
    assert.equal(cut.status, invalid ? "ROLLED_BACK" : "VERIFIED", JSON.stringify(cut.verification));
    if (invalid) {
      assert.ok(cut.verification.checks.some((check: any) => check.name.includes("speech-continuity") && !check.passed));
    } else {
      const intermediate = await f.inspect();
      const fresh = await f.normalize("selected-right");
      const gain = await f.call("skill.execute", { previewToken: fresh.previewToken });
      assert.equal(gain.status, "VERIFIED");
      await f.call("edit.undo", { transactionId: gain.transactionIds[0] });
      assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(intermediate));
      await f.call("edit.undo", { transactionId: cut.transactionIds[0] });
    }
    assert.equal(canonicalSnapshotDigest(await f.inspect()), canonicalSnapshotDigest(original));
  });
}
