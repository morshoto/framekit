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

test("MCP lists stable project identities, selects an explicit timeline, and rejects ambiguity", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-alpha",
    projectName: "Alpha",
    timelineId: "sequence-alpha-main",
    timelineName: "Main",
    clips: [],
  });
  const catalog = {
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
    activeProjectId: "project-alpha",
    activeSequenceId: "sequence-alpha-main",
  };
  const projectAdapter = adapter as typeof adapter & {
    listProjects: () => Promise<typeof catalog>;
    selectProject: (selection: { projectId: string; sequenceId?: string }) => Promise<typeof catalog>;
  };
  projectAdapter.listProjects = async () => structuredClone(catalog);
  projectAdapter.selectProject = async ({ projectId, sequenceId }) => {
    const project = catalog.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND: ${projectId}`);
    const targetSequenceId = sequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
    if (!targetSequenceId) throw new Error(`AMBIGUOUS_PROJECT_TARGET: ${projectId} has multiple sequences`);
    if (!project.sequences.some((candidate) => candidate.id === targetSequenceId)) {
      throw new Error(`SEQUENCE_NOT_FOUND: ${targetSequenceId}`);
    }
    catalog.activeProjectId = projectId;
    catalog.activeSequenceId = targetSequenceId;
    return structuredClone(catalog);
  };

  const client = new Client({ name: "project-selection-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new AgentVideoRuntime(projectAdapter));
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} })));
    assert.equal(listed.activeProjectId, "project-alpha");
    assert.equal(listed.activeSequenceId, "sequence-alpha-main");
    assert.deepEqual(listed.projects[0].sequences.map((sequence: { id: string }) => sequence.id), [
      "sequence-alpha-main",
      "sequence-alpha-social",
    ]);

    const selected = JSON.parse(textFrom(await client.callTool({
      name: "project.select",
      arguments: { projectId: "project-beta", sequenceId: "sequence-beta-main" },
    })));
    assert.equal(selected.activeProjectId, "project-beta");
    assert.equal(selected.activeSequenceId, "sequence-beta-main");

    const ambiguous = await client.callTool({ name: "project.select", arguments: { projectId: "project-alpha" } });
    assert.equal(ambiguous.isError, true);
    assert.match(textFrom(ambiguous), /AMBIGUOUS_PROJECT_TARGET/);
  } finally {
    await client.close();
    await server.close();
  }
});
