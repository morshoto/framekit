import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { buildSkillToolCatalog } from "../../apps/mcp-server/src/tools/skills/catalog.js";
import { SKILL_TOOL_METADATA } from "../../apps/mcp-server/src/tools/skills/metadata.js";
import { registerSkillTools } from "../../apps/mcp-server/src/tools/skills/register.js";

async function listSkillTools() {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "skill-catalog-project",
    projectName: "Skill Catalog",
    timelineId: "skill-catalog-sequence",
    timelineName: "Main",
    clips: [],
  }));
  const server = new McpServer({ name: "skill-catalog", version: "1.0.0" });
  registerSkillTools(server, runtime);
  const client = new Client({ name: "skill-catalog-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("skill tool catalog matches public tools/list and carries typed metadata", async () => {
  const result = buildSkillToolCatalog(SKILL_TOOL_METADATA, await listSkillTools());
  assert.deepEqual(result.errors, []);
  assert.equal(result.catalog.schemaVersion, 1);
  assert.deepEqual(result.catalog.tools.map(({ name }) => name), [
    "skill.list",
    "skill.inspect",
    "skill.preview",
    "skill.execute",
  ]);

  const byName = new Map(result.catalog.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("skill.inspect")?.inputSchema.required, ["skill"]);
  assert.deepEqual(byName.get("skill.preview")?.inputSchema.required, ["skill", "arguments"]);
  assert.deepEqual(byName.get("skill.execute")?.approval, { kind: "runtime-preview-token", required: true });
  assert.equal(byName.get("skill.preview")?.effect, "preview");
  assert.ok(byName.get("skill.list")?.examples.length);
});

test("skill tool catalog rejects duplicate names and missing effect or approval metadata", async () => {
  const first = SKILL_TOOL_METADATA[0]!;
  const malformed = {
    ...first,
    name: "skill.custom",
    effect: undefined,
    approval: undefined,
  };
  const result = buildSkillToolCatalog(
    [...SKILL_TOOL_METADATA, first, malformed],
    await listSkillTools(),
  );

  assert.match(result.errors.join("\n"), /duplicate metadata name/i);
  assert.match(result.errors.join("\n"), /skill\.custom.*effect/i);
  assert.match(result.errors.join("\n"), /skill\.custom.*approval/i);
});

test("skill tool catalog reports missing tools and public description or schema drift", async () => {
  const tools = await listSkillTools();
  const changed = tools
    .filter(({ name }) => name !== "skill.execute")
    .map((tool) => tool.name === "skill.preview"
      ? { ...tool, description: "Changed preview description" }
      : tool);
  const result = buildSkillToolCatalog(SKILL_TOOL_METADATA, changed);

  assert.match(result.errors.join("\n"), /skill\.execute.*missing/i);
  assert.match(result.errors.join("\n"), /skill\.preview.*description drift/i);

  const schemaChanged = tools.map((tool) => tool.name === "skill.inspect"
    ? { ...tool, inputSchema: { ...tool.inputSchema, required: ["version"] } }
    : tool);
  const schemaResult = buildSkillToolCatalog(SKILL_TOOL_METADATA, schemaChanged);
  assert.match(schemaResult.errors.join("\n"), /skill\.inspect.*required input drift/i);
});
