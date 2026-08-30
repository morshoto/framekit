import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

test("release corpus covers both v0.0.3 workflow families and safety cases", async () => {
  const raw = await readFile(new URL("./corpus.json", import.meta.url), "utf8");
  const corpus = JSON.parse(raw) as {
    schemaVersion: number;
    workflows: Array<{ id: string; family: string; expectedOutcome: string }>;
  };

  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.workflows.length >= 12);
  assert.deepEqual(
    new Set(corpus.workflows.map((workflow) => workflow.family)),
    new Set(["filler-removal", "dialogue-normalization"]),
  );
  for (const outcome of ["verified", "skipped", "rolled-back"]) {
    assert.ok(corpus.workflows.some((workflow) => workflow.expectedOutcome === outcome), outcome);
  }
});

test("generic MCP Skill surface discovers both release workflows", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "release-gate-project",
    projectName: "Release Gate",
    timelineId: "release-gate-timeline",
    timelineName: "Main Edit",
    clips: [],
  });
  const server = createMcpServer(new AgentVideoRuntime(adapter));
  const client = new Client({ name: "release-gate-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "skill.list"));
    assert.ok(tools.tools.some((tool) => tool.name === "skill.inspect"));
    assert.ok(tools.tools.some((tool) => tool.name === "skill.preview"));
    assert.ok(tools.tools.some((tool) => tool.name === "skill.execute"));

    const listed = await client.callTool({ name: "skill.list", arguments: {} });
    const content = listed.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content[0]?.text ?? "null") as Array<{ id: string; version: number }>;
    assert.deepEqual(payload.map((skill) => skill.id), ["filler-removal", "dialogue-normalization"]);
    assert.ok(payload.every((skill) => skill.version === 1));
  } finally {
    await client.close();
    await server.close();
  }
});
