import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, diffSnapshots, type ProjectSelection } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function fixture(options: {
  projects?: NonNullable<ConstructorParameters<typeof InMemoryEditorAdapter>[0]>["projects"];
  projectSnapshots?: NonNullable<ConstructorParameters<typeof InMemoryEditorAdapter>[0]>["projectSnapshots"];
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
    projectSnapshots: options.projectSnapshots,
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
  const [change] = result.changes;
  assert.equal(change?.scope, "clip");
  if (!change || change.scope !== "clip") throw new Error("expected a clip change");
  assert.equal(change.after?.name, "B updated");
  assert.deepEqual(change.before?.name, "B");
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

test("canonical changes report a stale result for a mismatched revision cursor", async () => {
  const adapter = fixture();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();

  const result = await runtime.timelineChangesSince({
    target: {
      projectId: before.projectId,
      sequenceId: before.timeline.id,
    },
    from: {
      ...before.revision,
      sequence: before.revision.sequence + 1,
    },
  });

  assert.equal(result.status, "stale");
  assert.match(result.reason ?? "", /revision/i);
  assert.deepEqual(result.changes, []);
});

test("canonical changes report target drift during the current read", async () => {
  const projects = [
    {
      id: "project-389",
      name: "Ordered Changes",
      sequences: [{ id: "sequence-389", name: "Main Edit" }],
    },
    {
      id: "project-other",
      name: "Other Project",
      sequences: [{ id: "sequence-other", name: "Other Edit" }],
    },
  ];
  const adapter = fixture({
    projects,
    projectSnapshots: [
      {
        projectId: "project-389",
        projectName: "Ordered Changes",
        timelineId: "sequence-389",
        timelineName: "Main Edit",
        clips: [{ id: "clip-389", name: "Original", start: 0, duration: 2, track: 1 }],
      },
      {
        projectId: "project-other",
        projectName: "Other Project",
        timelineId: "sequence-other",
        timelineName: "Other Edit",
        clips: [{ id: "clip-other", name: "Other", start: 0, duration: 2, track: 1 }],
      },
    ],
  });
  const originalGetCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => {
    const capabilities = await originalGetCapabilities();
    return {
      ...capabilities,
      editor: { ...capabilities.editor, incrementalChanges: false },
    };
  };
  const originalReadProject = adapter.readProject.bind(adapter);
  let readCount = 0;
  adapter.readProject = async () => {
    readCount += 1;
    if (readCount === 2) await adapter.selectProject?.({ projectId: "project-other", sequenceId: "sequence-other" });
    return originalReadProject();
  };

  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const result = await runtime.timelineChangesSince({
    target: { projectId: "project-389", sequenceId: "sequence-389" },
    from: before.revision,
  });

  assert.equal(result.status, "stale");
  assert.match(result.reason ?? "", /target/i);
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

test("timeline diffs order changes by exact timeline position", async () => {
  const before = await fixture().readProject();
  const after = structuredClone(before);
  after.revision = { id: "rev-1", sequence: 1, timestamp: new Date(1).toISOString() };
  after.timeline.clips = after.timeline.clips.map((clip) => ({
    ...clip,
    name: `${clip.name} updated`,
  }));

  const diff = diffSnapshots(before, after);

  assert.deepEqual(diff.changes.map((change) => change.itemId), ["clip-a", "clip-b"]);
});

test("ordered changes preserve after values for added timeline items", async () => {
  const before = await fixture().readProject();
  const after = structuredClone(before);
  after.revision = { id: "rev-1", sequence: 1, timestamp: new Date(1).toISOString() };
  after.timeline.markers.push({
    id: "marker-added",
    start: 1,
    duration: 0,
    name: "Added",
    startTime: { value: "1", timescale: "1" },
    durationTime: { value: "0", timescale: "1" },
  });

  const diff = diffSnapshots(before, after);
  const change = diff.changes.find((candidate) => candidate.itemId === "marker-added");

  assert.equal(change?.scope, "marker");
  assert.equal(change?.after?.id, "marker-added");
});
