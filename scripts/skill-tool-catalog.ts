import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { buildSkillToolCatalog } from "../apps/mcp-server/src/tools/skills/catalog.js";
import { SKILL_TOOL_METADATA } from "../apps/mcp-server/src/tools/skills/metadata.js";
import { registerSkillTools } from "../apps/mcp-server/src/tools/skills/register.js";

const server = new McpServer({ name: "framekit-skill-tool-catalog", version: "1.0.0" });
const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
  projectId: "skill-catalog-project",
  projectName: "Skill Catalog",
  timelineId: "skill-catalog-sequence",
  timelineName: "Main",
  clips: [],
}));
registerSkillTools(server, runtime);

const client = new Client({ name: "framekit-skill-tool-catalog", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = buildSkillToolCatalog(SKILL_TOOL_METADATA, (await client.listTools()).tools);
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  } else if (process.argv.includes("--check")) {
    process.stdout.write(`Skill tool catalog matches tools/list (${result.catalog.tools.length} tools).\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.catalog, null, 2)}\n`);
  }
} finally {
  await client.close();
  await server.close();
}
