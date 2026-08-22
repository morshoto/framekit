import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

function multiProjectAdapter(): InMemoryEditorAdapter {
  return new InMemoryEditorAdapter({
    projectId: "project-alpha",
    projectName: "Alpha",
    timelineId: "sequence-alpha-main",
    timelineName: "Main",
    clips: [],
    projects: [
      {
        id: "project-alpha",
        name: "Alpha",
        sequences: [
          { id: "sequence-alpha-main", name: "Main" },
          { id: "sequence-alpha-social", name: "Social" },
        ],
      },
      {
        id: "project-beta",
        name: "Beta",
        sequences: [{ id: "sequence-beta-main", name: "Main" }],
      },
    ],
    projectSnapshots: [
      {
        projectId: "project-alpha",
        projectName: "Alpha",
        timelineId: "sequence-alpha-main",
        timelineName: "Main",
        clips: [],
      },
      {
        projectId: "project-alpha",
        projectName: "Alpha",
        timelineId: "sequence-alpha-social",
        timelineName: "Social",
        clips: [],
      },
      {
        projectId: "project-beta",
        projectName: "Beta",
        timelineId: "sequence-beta-main",
        timelineName: "Main",
        clips: [],
      },
    ],
  });
}

test("MCP lists stable project identities, selects an explicit timeline, and rejects ambiguity", async () => {
  const adapter = multiProjectAdapter();
  const client = new Client({ name: "project-selection-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new AgentVideoRuntime(adapter));
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} })));
    assert.equal(listed.activeProjectId, "project-alpha");
    assert.equal(listed.activeSequenceId, "sequence-alpha-main");
    assert.deepEqual(listed.projects[0].sequences.map((sequence: { id: string }) => sequence.id), [
      "sequence-alpha-main",
      "sequence-alpha-social",
    ]);

    const selectedMain = JSON.parse(textFrom(await client.callTool({
      name: "project.select",
      arguments: { projectId: "project-alpha", sequenceId: "sequence-alpha-main" },
    })));
    assert.equal(selectedMain.activeProjectId, "project-alpha");
    assert.equal(selectedMain.activeSequenceId, "sequence-alpha-main");

    const selected = JSON.parse(textFrom(await client.callTool({
      name: "project.select",
      arguments: { projectId: "project-beta", sequenceId: "sequence-beta-main" },
    })));
    assert.equal(selected.activeProjectId, "project-beta");
    assert.equal(selected.activeSequenceId, "sequence-beta-main");
    const inspected = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    assert.equal(inspected.projectId, "project-beta");
    assert.equal(inspected.timeline.id, "sequence-beta-main");

    const selectedSocial = JSON.parse(textFrom(await client.callTool({
      name: "project.select",
      arguments: { projectId: "project-alpha", sequenceId: "sequence-alpha-social" },
    })));
    assert.equal(selectedSocial.activeProjectId, "project-alpha");
    assert.equal(selectedSocial.activeSequenceId, "sequence-alpha-social");
    const inspectedSocial = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    assert.equal(inspectedSocial.projectId, "project-alpha");
    assert.equal(inspectedSocial.timeline.id, "sequence-alpha-social");

    const ambiguous = await client.callTool({ name: "project.select", arguments: { projectId: "project-alpha" } });
    assert.equal(ambiguous.isError, true);
    assert.match(textFrom(ambiguous), /AMBIGUOUS_PROJECT_TARGET/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-memory restore rejects another project's snapshot without mutating the active target", async () => {
  const adapter = multiProjectAdapter();
  const alpha = await adapter.readProject();
  await adapter.selectProject({ projectId: "project-beta", sequenceId: "sequence-beta-main" });
  const beta = await adapter.readProject();

  await assert.rejects(adapter.restore(alpha, beta.revision), /TARGET_MISMATCH/);

  const inspected = await adapter.readProject();
  const catalog = await adapter.listProjects();
  assert.equal(inspected.projectId, "project-beta");
  assert.equal(inspected.timeline.id, "sequence-beta-main");
  assert.equal(catalog.activeProjectId, inspected.projectId);
  assert.equal(catalog.activeSequenceId, inspected.timeline.id);

  await adapter.selectProject({ projectId: "project-alpha", sequenceId: "sequence-alpha-main" });
  assert.equal((await adapter.readProject()).projectId, "project-alpha");
});

test("in-memory restore rejects another sequence's snapshot without mutating the active target", async () => {
  const adapter = multiProjectAdapter();
  const main = await adapter.readProject();
  await adapter.selectProject({ projectId: "project-alpha", sequenceId: "sequence-alpha-social" });
  const social = await adapter.readProject();

  await assert.rejects(adapter.restore(main, social.revision), /TARGET_MISMATCH/);

  const inspected = await adapter.readProject();
  const catalog = await adapter.listProjects();
  assert.equal(inspected.projectId, "project-alpha");
  assert.equal(inspected.timeline.id, "sequence-alpha-social");
  assert.equal(catalog.activeProjectId, inspected.projectId);
  assert.equal(catalog.activeSequenceId, inspected.timeline.id);
});

test("runtime undo rejects a transaction after the active target changes without delegating restore", async () => {
  const adapter = multiProjectAdapter();
  const originalRestore = adapter.restore.bind(adapter);
  let restoreCalls = 0;
  adapter.restore = async (snapshot, expectedRevision) => {
    restoreCalls += 1;
    return originalRestore(snapshot, expectedRevision);
  };
  const runtime = new AgentVideoRuntime(adapter);
  const transaction = await runtime.edit({
    type: "add-marker",
    timelineId: "sequence-alpha-main",
    marker: { id: "marker-alpha", start: 0, duration: 0, name: "Alpha marker" },
  });
  await runtime.selectProject({ projectId: "project-beta", sequenceId: "sequence-beta-main" });

  await assert.rejects(runtime.undo(transaction.id), /TARGET_MISMATCH/);

  assert.equal(restoreCalls, 0);
  const inspected = await runtime.inspectProject();
  const catalog = await runtime.listProjects();
  assert.equal(inspected.projectId, "project-beta");
  assert.equal(inspected.timeline.id, "sequence-beta-main");
  assert.equal(catalog.activeProjectId, inspected.projectId);
  assert.equal(catalog.activeSequenceId, inspected.timeline.id);
});
