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
