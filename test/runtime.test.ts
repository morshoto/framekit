import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEditorAdapter } from "../src/adapters/in-memory-editor.js";
import { AgentVideoRuntime } from "../src/core/runtime.js";

function createRuntime() {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Phase 0 Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-1", name: "Interview", start: 0, duration: 10, track: 1 },
    ],
  }));
}

test("Phase 0 proves read, write, read-after-write, and diff", async () => {
  const runtime = createRuntime();

  const before = await runtime.inspectProject();
  assert.equal(before.timeline.clips[0]?.name, "Interview");

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "clip-1",
    name: "Interview - Clean",
  });

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.before.timeline.clips[0]?.name, "Interview");
  assert.equal(transaction.after.timeline.clips[0]?.name, "Interview - Clean");
  assert.deepEqual(transaction.diff.modified, [
    {
      type: "ITEM_MODIFIED",
      itemId: "clip-1",
      before: { id: "clip-1", name: "Interview", start: 0, duration: 10, track: 1 },
      after: { id: "clip-1", name: "Interview - Clean", start: 0, duration: 10, track: 1 },
    },
  ]);
});

test("Phase 0 rejects stale writes", async () => {
  const runtime = createRuntime();
  const base = await runtime.inspectProject();

  await runtime.edit({ type: "rename-clip", clipId: "clip-1", name: "First" });

  await assert.rejects(
    runtime.edit({
      type: "rename-clip",
      clipId: "clip-1",
      name: "Stale",
      baseRevision: base.revision,
    }),
    /STALE_CONTEXT/,
  );
});
