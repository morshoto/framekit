import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, canonicalSnapshotDigest } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function fixture() {
  const adapter = new InMemoryEditorAdapter({ projectId: "cleanup", projectName: "Cleanup", timelineId: "sequence", timelineName: "Sequence",
    clips: [{ id: "speech", mediaId: "source", name: "Speech", start: 0, duration: 4, track: 0, gainDb: 0 }],
    media: [{ mediaId: "source", source: "fixture.wav", duration: 4 }] });
  const runtime = new AgentVideoRuntime(adapter);
  const gain = async (gainDb: number) => {
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: [{ type: "set-gain", clipId: "speech", gainDb }] });
    return runtime.executeEdit(preview.previewToken);
  };
  return { adapter, runtime, gain };
}

test("verified Undo restoration enables only the preceding transaction", async () => {
  const { runtime, gain } = fixture();
  const baseline = await runtime.inspectProject();
  const first = await gain(1); const second = await gain(2); const third = await gain(3);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  await runtime.undo(third.id);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  const middle = await runtime.undo(second.id);
  assert.equal(canonicalSnapshotDigest(middle), canonicalSnapshotDigest(first.after));
  assert.notEqual(middle.revision.id, first.after.revision.id);
  assert.equal(canonicalSnapshotDigest(await runtime.undo(first.id)), canonicalSnapshotDigest(baseline));
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  await assert.rejects(runtime.undo(second.id), /STALE_CONTEXT/);
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(baseline));
});

test("external same-content restoration does not authorize stale Undo", async () => {
  const { adapter, runtime, gain } = fixture();
  const first = await gain(1); const second = await gain(2);
  await adapter.restore(first.after, second.after.revision);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]!.gainDb, 1);
});

test("failed Undo readback cannot unlock the parent or be replayed", async () => {
  const { adapter, runtime, gain } = fixture();
  const first = await gain(1); const second = await gain(2);
  const restore = adapter.restore.bind(adapter);
  adapter.restore = async (snapshot, revision) => {
    const wrong = structuredClone(snapshot); wrong.timeline.clips[0]!.gainDb = 9;
    await restore(wrong, revision);
  };
  await assert.rejects(runtime.undo(second.id), /ROLLBACK_FAILED/);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  await assert.rejects(runtime.undo(second.id), /STALE_CONTEXT/);
  assert.equal((await runtime.inspectProject()).timeline.clips[0]!.gainDb, 9);
});

test("a new branch after verified Undo retains its own restoration chain", async () => {
  const { runtime, gain } = fixture();
  const baseline = await runtime.inspectProject();
  const first = await gain(1); const second = await gain(2);
  await runtime.undo(second.id);
  const replacement = await gain(4);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
  await runtime.undo(replacement.id);
  await assert.rejects(runtime.undo(second.id), /STALE_CONTEXT/);
  assert.equal(canonicalSnapshotDigest(await runtime.undo(first.id)), canonicalSnapshotDigest(baseline));
});

for (const failure of ["partial-apply", "unexpected-diff"]) test(`${failure} recovery preserves the earlier Undo`, async () => {
  const { adapter, runtime, gain } = fixture(); const baseline = await runtime.inspectProject();
  const first = await gain(1); const apply = adapter.applyTransaction.bind(adapter);
  adapter.applyTransaction = async (...args) => {
    await apply(...args);
    if (failure === "partial-apply") throw new Error("controlled partial failure");
    const current = await adapter.readProject();
    await adapter.apply({ type: "rename-clip", clipId: "speech", name: "unexpected" }, current.revision);
  };
  if (failure === "partial-apply") await assert.rejects(gain(2), /TRANSACTION_FAILED/);
  else assert.equal((await gain(2)).status, "ROLLED_BACK");
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(first.after));
  assert.equal(canonicalSnapshotDigest(await runtime.undo(first.id)), canonicalSnapshotDigest(baseline));
});

test("concurrent Undo requests cannot dispatch restoration twice", async () => {
  const { adapter, runtime, gain } = fixture(); const transaction = await gain(1);
  const restore = adapter.restore.bind(adapter); let attempts = 0;
  adapter.restore = async (...args) => { attempts++; await new Promise(resolve => setImmediate(resolve)); await restore(...args); };
  const results = await Promise.allSettled([runtime.undo(transaction.id), runtime.undo(transaction.id)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(attempts, 1);
});

test("failed restoration dispatch is consumed even when the editor did not advance", async () => {
  const { adapter, runtime, gain } = fixture(); const transaction = await gain(1); let attempts = 0;
  adapter.restore = async () => { attempts++; throw new Error("controlled pending restoration"); };
  await assert.rejects(runtime.undo(transaction.id), /controlled pending restoration/);
  await assert.rejects(runtime.undo(transaction.id), /STALE_CONTEXT/);
  assert.equal(attempts, 1);
});

test("artifact Undo chaining retains the exact source-file guard", async t => {
  const { FcpxmlDocumentAdapter } = await import("@framekit/final-cut");
  const { mkdtemp, writeFile, appendFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "framekit-undo-chain-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "project.fcpxml");
  await writeFile(path, '<fcpxml version="1.11"><resources><asset id="source" src="file:///fixture.wav" duration="4s" /></resources><library><event><project uid="project" name="Undo"><sequence uid="sequence" duration="4s"><spine><asset-clip id="speech" ref="source" offset="0s" duration="4s" /></spine></sequence></project></event></library></fcpxml>');
  const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(path));
  const gain = async (gainDb: number) => runtime.edit({ type: "set-gain", clipId: "speech", gainDb });
  const first = await gain(1); const second = await gain(2);
  await runtime.undo(second.id);
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(first.after));
  const third = await gain(3); await runtime.undo(third.id);
  await appendFile(path, '\n<!-- external edit without changing timeline semantics -->');
  await assert.rejects(runtime.undo(first.id), /ARTIFACT_SOURCE_CHANGED/);
});

test("same-revision restoration cannot authorize the earlier Undo", async () => {
  const { adapter, runtime, gain } = fixture(); const first = await gain(1); const second = await gain(2);
  const read = adapter.readProject.bind(adapter); const restore = adapter.restore.bind(adapter); let restored = false;
  adapter.restore = async (...args) => { await restore(...args); restored = true; };
  adapter.readProject = async () => { const value = await read(); if (restored) value.revision = second.after.revision; return value; };
  await assert.rejects(runtime.undo(second.id), /ROLLBACK_FAILED: restoration did not advance/);
  await assert.rejects(runtime.undo(first.id), /STALE_CONTEXT/);
});
