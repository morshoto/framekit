import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

type JsonSchema = {
  anyOf?: JsonSchema[];
  properties?: Record<string, { const?: unknown }>;
  required?: string[];
};

const operationRequirements = {
  "rename-clip": ["clipId", "name", "type"],
  "trim-clip": ["clipId", "duration", "type"],
  "set-gain": ["clipId", "gainDb", "type"],
  "reduce-noise": ["clipId", "range", "reductionDb", "type"],
  "set-color-correction": ["clipId", "correction", "type"],
  "ripple-delete": ["range", "timelineId", "type"],
  "add-marker": ["marker", "timelineId", "type"],
} as const;

function runtime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "schema-project",
    projectName: "Schema Contract",
    timelineId: "schema-timeline",
    timelineName: "Main",
    clips: [{ id: "schema-clip", mediaId: "schema-media", name: "Interview", start: 0, duration: 10, track: 1 }],
    media: [{ mediaId: "schema-media", source: "interview.mov", mediaKind: "video", duration: 10 }],
  }));
}

function branchFor(schema: JsonSchema, type: string): JsonSchema {
  const branch = schema.anyOf?.find((candidate) => candidate.properties?.type?.const === type);
  assert.ok(branch, `missing ${type} schema branch`);
  return branch;
}

function matchesPublishedSchema(schema: JsonSchema, value: Record<string, unknown>): boolean {
  if (schema.required?.some((key) => !(key in value))) return false;
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.const !== undefined && value[key] !== property.const) return false;
  }
  return schema.anyOf?.some((branch) => matchesPublishedSchema(branch, value)) ?? true;
}

async function connectedClient() {
  const server = createMcpServer(runtime());
  const client = new Client({ name: "edit-tool-schema-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

test("single-edit tools advertise operation-specific required fields", async () => {
  const { client, server } = await connectedClient();
  try {
    const tools = await client.listTools();
    for (const toolName of ["timeline.edit", "artifact.edit", "editor.timeline.edit"]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool);
      const schema = tool.inputSchema as JsonSchema;
      for (const [type, required] of Object.entries(operationRequirements)) {
        const branch = branchFor(schema, type);
        assert.deepEqual(branch.required?.slice().sort(), [
          ...required,
          ...(toolName === "artifact.edit" ? ["artifactPath", "baseRevision"] : []),
          ...(toolName === "editor.timeline.edit" ? ["baseRevision", "projectId", "sequenceId"] : []),
        ].sort(), `${toolName} ${type}`);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("published root schema validates non-last edit operations", async () => {
  const { client, server } = await connectedClient();
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "editor.timeline.edit");
    assert.ok(tool);
    const schema = tool.inputSchema as JsonSchema;
    assert.equal(schema.properties?.type, undefined);

    for (const request of [
      {
        type: "rename-clip",
        clipId: "schema-clip",
        name: "Interview Clean",
        baseRevision: "1",
        projectId: "schema-project",
        sequenceId: "schema-timeline",
      },
      {
        type: "trim-clip",
        clipId: "schema-clip",
        duration: 5,
        baseRevision: "1",
        projectId: "schema-project",
        sequenceId: "schema-timeline",
      },
    ]) {
      assert.equal(matchesPublishedSchema(schema, request), true, request.type);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("editor.timeline.edit validates trim duration before its handler", async () => {
  const { client, server } = await connectedClient();
  try {
    const project = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const invalid = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: project.projectId,
        sequenceId: project.timeline.id,
        type: "trim-clip",
        clipId: "schema-clip",
        durationTime: { value: "1", timescale: "24" },
        baseRevision: project.revision,
      },
    });
    assert.equal(invalid.isError, true);
    assert.match(textFrom(invalid), /Input validation error/);
    assert.match(textFrom(invalid), /Required at duration/);

    const valid = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: project.projectId,
        sequenceId: project.timeline.id,
        type: "trim-clip",
        clipId: "schema-clip",
        duration: 5,
        baseRevision: project.revision,
      },
    });
    assert.equal(valid.isError, undefined);
    assert.equal(JSON.parse(textFrom(valid)).status, "VERIFIED");
  } finally {
    await client.close();
    await server.close();
  }
});

test("single-edit tools reject fields from another operation", async () => {
  const { client, server } = await connectedClient();
  try {
    const project = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const invalid = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: project.projectId,
        sequenceId: project.timeline.id,
        type: "rename-clip",
        clipId: "schema-clip",
        name: "Interview Clean",
        duration: 5,
        baseRevision: project.revision,
      },
    });
    assert.equal(invalid.isError, true);
    assert.match(textFrom(invalid), /Unrecognized key\(s\).*duration/);
  } finally {
    await client.close();
    await server.close();
  }
});
