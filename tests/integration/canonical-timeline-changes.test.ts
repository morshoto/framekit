import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, type ProjectSelection } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function fixture(options: {
  projects?: NonNullable<ConstructorParameters<typeof InMemoryEditorAdapter>[0]>["projects"];
} = {}) {
  return new InMemoryEditorAdapter({
    projectId: "project-389",
    projectName: "Ordered Changes",
    timelineId: "sequence-389",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-b", name: "B", start: 5, duration: 2, track: 1 },
      { id: "clip-a", name: "A", start: 0, duration: 2, track: 1 },
    ],
    projects: options.projects,
  });
}

test("canonical changes bind the selected target and preserve ordered provenance", async () => {
  const adapter = fixture();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  await runtime.edit({ type: "rename-clip", clipId: "clip-b", name: "B updated" });

  const result = await runtime.timelineChangesSince({
    target: {
      projectId: "project-389",
      sequenceId: "sequence-389",
    },
    from: before.revision,
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.target, {
    projectId: "project-389",
    sequenceId: "sequence-389",
  });
  assert.equal(result.source.guarantee, "canonical-read");
  assert.deepEqual(result.changes.map((change) => change.itemId), ["clip-b"]);
  assert.equal(result.changes[0]?.after?.name, "B updated");
  assert.deepEqual(result.changes[0]?.before?.name, "B");
});

test("canonical changes report a stale result for a different active target", async () => {
  const adapter = fixture();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();

  const result = await runtime.timelineChangesSince({
    target: {
      projectId: "other-project",
      sequenceId: "other-sequence",
    },
    from: before.revision,
  });

  assert.equal(result.status, "stale");
  assert.match(result.reason ?? "", /active target/i);
  assert.deepEqual(result.changes, []);
});

test("canonical changes report ambiguity when a project has multiple sequences", async () => {
  const projects: NonNullable<ConstructorParameters<typeof InMemoryEditorAdapter>[0]>["projects"] = [
    {
      id: "project-389",
      name: "Ordered Changes",
      sequences: [
        { id: "sequence-389", name: "Main Edit" },
        { id: "sequence-alt", name: "Alternate Edit" },
      ],
    },
  ];
  const runtime = new AgentVideoRuntime(fixture({ projects }));
  const before = await runtime.inspectProject();

  const target: ProjectSelection = { projectId: "project-389" };
  const result = await runtime.timelineChangesSince({ target, from: before.revision });

  assert.equal(result.status, "ambiguous");
  assert.match(result.reason ?? "", /sequence/i);
  assert.deepEqual(result.changes, []);
});

test("canonical changes never promote metadata-only capability", async () => {
  const adapter = fixture();
  const originalCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => {
    const capabilities = await originalCapabilities();
    return {
      ...capabilities,
      editor: {
        ...capabilities.editor,
        canonicalTimelineMode: "metadata-only",
        projectRead: false,
        timelineSnapshotRead: false,
        incrementalChanges: false,
      },
    };
  };
  const runtime = new AgentVideoRuntime(adapter);
  const before = await adapter.readProject();

  const result = await runtime.timelineChangesSince({
    target: {
      projectId: "project-389",
      sequenceId: "sequence-389",
    },
    from: before.revision,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.source.guarantee, "metadata-only");
  assert.deepEqual(result.changes, []);
});
