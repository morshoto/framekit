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
async function fixture(t: test.TestContext, failOutput = false) {
  const directory = await mkdtemp(join(tmpdir(), "framekit-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "speech.wav"); const bytes = pcm(4, 0.1); await writeFile(source, bytes);
  const words = [{ text: "hello", start: 0.2, end: 0.6, confidence: 0.99 },
    { text: "um", start: 1, end: 1.3, confidence: 0.99, filler: true },
    { text: "world", start: 1.6, end: 2.2, confidence: 0.99 }];
  const adapter = new InMemoryEditorAdapter({ projectId: "cleanup", projectName: "Cleanup", timelineId: "sequence", timelineName: "Sequence",
    frameDuration: { value: "1001", timescale: "24000" },
    clips: [{ id: "selected", mediaId: "speech", name: "Selected", start: 0, duration: 4, track: 0, gainDb: 0 },
      { id: "reused", mediaId: "speech", name: "Reused", start: 4, duration: 4, track: 0, gainDb: 0 }],
    media: [{ mediaId: "speech", source, sourceDigest: digest(bytes), mediaKind: "audio", duration: 4, speech: { words } }] });
  const speech: SpeechAnalyzer = { descriptor: { id: "controlled-speech", provider: "test", version: "1" }, capabilities: { transcription: true, vad: true },
    analyze: async ({ project }, range) => {
      const edited = project.timeline.clips.find(clip => clip.id === "selected")!.duration < 4;
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
    const text = result.content?.find(item => item.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text);
    return JSON.parse(text as string);
  };
  const inspect = () => call("project.inspect");
  const normalize = async () => call("skill.preview", { skill: "dialogue-normalization", arguments: {
    baseRevision: (await inspect()).revision, mediaId: "speech", occurrenceId: "selected", targetLufs: -20, toleranceDb: 0.2 } });
  return { call, inspect, normalize, writes: () => writes, exports: () => exports };
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
