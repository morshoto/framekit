import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer, McpServer as V2McpServer } from "@modelcontextprotocol/server";
import { AgentVideoRuntime, type SkillDefinition } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../../apps/mcp-server/src/server.js";
import { registerSkillTools } from "../../../apps/mcp-server/src/tools/skills/register.js";
import { registerValidatedTool } from "../../../apps/mcp-server/src/tools/validated-tool.js";
import { z } from "zod/v4";

function textFrom(value: unknown): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return content?.[0]?.text ?? "";
}

test("public v2 registration rejects invalid input before invoking the handler", async () => {
  const server = new V2McpServer({ name: "validation", version: "1" });
  let calls = 0;
  registerValidatedTool(server, "fixture.validated", { inputSchema: z.object({ name: z.string().min(1) }) }, async ({ name }) => {
    calls++;
    return { content: [{ type: "text", text: name }] };
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const schema = (await client.listTools()).tools.find((tool) => tool.name === "fixture.validated")?.inputSchema;
    assert.deepEqual(schema?.required, ["name"]);
    const invalid = await client.callTool({ name: "fixture.validated", arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.parse(textFrom(invalid)).code, "INPUT_INVALID");
    assert.equal(calls, 0);
    const valid = await client.callTool({ name: "fixture.validated", arguments: { name: "ready" } });
    assert.equal(textFrom(valid), "ready");
    assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); }
});

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

test("production server is built with the v2 SDK", async () => {
  const server = createMcpServer(new AgentVideoRuntime(adapter("sdk-v2")));
  assert.ok(server instanceof V2McpServer);
  await server.close();
});

test("skill tools register independently with the same names, schemas, and error mapping", async () => {
  const runtime = new AgentVideoRuntime(adapter("mcp-skill-family-project"));
  runtime.registerSkill(markerSkill());
  const server = new McpServer({ name: "skill-tools", version: "1.0.0" });
  registerSkillTools(server, runtime);
  const client = new Client({ name: "skill-tools-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...byName.keys()].filter((name) => name.startsWith("skill.")).sort(), [
      "skill.execute",
      "skill.inspect",
      "skill.list",
      "skill.preview",
    ]);
    assert.deepEqual(byName.get("skill.inspect")?.inputSchema.required, ["skill"]);
    assert.deepEqual(byName.get("skill.preview")?.inputSchema.required, ["skill", "arguments"]);
    assert.deepEqual(byName.get("skill.execute")?.inputSchema.required, ["previewToken"]);

    const malformedPreview = await client.callTool({
      name: "skill.preview",
      arguments: {
        skill: "fixture.mcp-marker",
        arguments: { baseRevision: { id: "stale", sequence: -1, timestamp: "" }, name: "Review" },
      },
    });
    assert.equal(malformedPreview.isError, true);
    assert.equal(JSON.parse(textFrom(malformedPreview)).code, "SKILL_INPUT_INVALID");
  } finally {
    await client.close();
    await server.close();
  }
});

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
