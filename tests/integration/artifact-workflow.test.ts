import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import {
  BACKGROUND_ARTIFACT_WORKFLOW,
} from "../../apps/mcp-server/src/routing.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event><project uid="artifact-workflow-project" name="Artifact Workflow">
    <sequence uid="artifact-workflow-sequence" duration="1s"><spine>
      <asset-clip id="artifact-workflow-clip" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("MCP exposes the explicit background artifact workflow", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-artifact-workflow-"));
  const artifactPath = join(directory, "project.fcpxml");
  await writeFile(artifactPath, FCPXML);
  const server = createMcpServer(new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath)), {
    connectionStatus: () => ({ state: "disconnected" }),
  });
  const client = new Client({ name: "artifact-workflow-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    for (const name of [
      "artifact.inspect",
      "artifact.edit.preview",
      "artifact.edit.execute",
      "artifact.edit.diff",
      "artifact.edit.verify",
      "artifact.edit.undo",
    ]) {
      assert.ok(tools.tools.find((tool) => tool.name === name), `${name} must be registered`);
    }
    for (const name of ["artifact.edit.preview", "artifact.edit.execute", "artifact.edit.diff", "artifact.edit.verify", "artifact.edit.undo"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.match(tool?.description ?? "", /artifact/i, name);
      assert.match(tool?.description ?? "", /Final Cut|background/i, name);
    }

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.deepEqual(editor.workflows.artifact, {
      mode: "background-artifact",
      tools: BACKGROUND_ARTIFACT_WORKFLOW,
      requiresFinalCutFrontmost: false,
      changesOpenTimeline: false,
    });

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "artifact.edit" },
    })));
    assert.equal(route.status, "editor-selected");
    assert.equal(route.selectedPath, "artifact");
    assert.deepEqual(route.workflow, BACKGROUND_ARTIFACT_WORKFLOW);
    assert.match(route.reason.message, /background|artifact/i);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
