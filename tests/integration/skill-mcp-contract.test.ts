import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, type SkillDefinition } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(value: unknown): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return content?.[0]?.text ?? "";
}

function markerSkill(): SkillDefinition {
  return {
    manifest: {
      contractVersion: 1,
      id: "fixture.mcp-marker",
      version: "1.2.0",
      title: "MCP marker",
      description: "Add a marker through the generic MCP surface.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false,
      },
      requirements: { type: "operation", operation: "add-marker" },
    },
    handler: {
      normalize: (input) => input as Record<string, unknown>,
      plan: (context, input) => ({
        operations: [{
          type: "add-marker" as const,
          timelineId: context.project.timeline.id,
          marker: { id: "mcp-marker", start: 1, duration: 0, name: input.name as string },
        }],
        affectedRanges: [{ start: 1, end: 1 }],
        warnings: [],
      }),
    },
  };
}

function adapter(projectId: string): InMemoryEditorAdapter {
  return new InMemoryEditorAdapter({
    projectId,
    projectName: "MCP Skill",
    timelineId: `${projectId}-timeline`,
    timelineName: "Main",
    clips: [],
  });
}

test("generic MCP Skill tools delegate discovery, inspection, preview, and token-only execution", async () => {
  const runtime = new AgentVideoRuntime(adapter("mcp-skill-project"));
  runtime.registerSkill(markerSkill());
  const server = createMcpServer(runtime);
  const client = new Client({ name: "skill-mcp-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = JSON.parse(textFrom(await client.callTool({ name: "skill.list", arguments: {} }))) as Array<{ id: string; availability: { available: boolean } }>;
    const listedMarker = listed.find((skill) => skill.id === "fixture.mcp-marker");
    assert.equal(listedMarker?.availability.available, true);

    const inspected = JSON.parse(textFrom(await client.callTool({
      name: "skill.inspect",
      arguments: { skill: "fixture.mcp-marker", version: "1.2.0" },
    }))) as { version: string; availability: { available: boolean } };
    assert.equal(inspected.version, "1.2.0");
    assert.equal(inspected.availability.available, true);

    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))) as {
      revision: { id: string; sequence: number; timestamp: string };
    };
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "skill.preview",
      arguments: {
        skill: "fixture.mcp-marker",
        version: "1.2.0",
        arguments: { baseRevision: before.revision, name: "Review" },
      },
    }))) as { previewToken: string; plan: { skillVersion: string; operations: unknown[] } };
    assert.equal(preview.plan.skillVersion, "1.2.0");
    assert.equal(preview.plan.operations.length, 1);
    assert.deepEqual(JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))), before);

    const rawOperationAttempt = await client.callTool({
      name: "skill.execute",
      arguments: { previewToken: "not-issued", operations: [{ type: "add-marker" }] },
    });
    assert.equal(rawOperationAttempt.isError, true);
    assert.equal(JSON.parse(textFrom(rawOperationAttempt)).code, "SKILL_PREVIEW_TOKEN_INVALID");

    const execution = JSON.parse(textFrom(await client.callTool({
      name: "skill.execute",
      arguments: { previewToken: preview.previewToken },
    }))) as { status: string };
    assert.equal(execution.status, "VERIFIED");
  } finally {
    await client.close();
    await server.close();
  }
});

test("generic MCP maps unavailable Skill requirements to structured errors", async () => {
  const runtime = new AgentVideoRuntime(adapter("mcp-unavailable-project"));
  const unavailable = markerSkill();
  unavailable.manifest.id = "fixture.mcp-unavailable";
  unavailable.manifest.requirements = { type: "analyzer", capability: "speechTranscribe" };
  runtime.registerSkill(unavailable);
  const server = createMcpServer(runtime);
  const client = new Client({ name: "skill-mcp-unavailable", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inspected = JSON.parse(textFrom(await client.callTool({ name: "skill.inspect", arguments: { skill: unavailable.manifest.id } }))) as {
      availability: { available: boolean; reasonCodes: string[] };
    };
    assert.equal(inspected.availability.available, false);
    assert.deepEqual(inspected.availability.reasonCodes, ["MISSING_ANALYZER_CAPABILITY"]);
  } finally {
    await client.close();
    await server.close();
  }
});
