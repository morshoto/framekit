import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FinalCutVideoExporter } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("MCP exposes verified video export and its capability", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-export-mcp-"));
  const outputPath = join(directory, "final.mp4");
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async () => {
      await writeFile(outputPath, "fixture video");
      return "started";
    },
    probe: async () => ({ durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true }),
    sleep: async () => undefined,
  });
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Export Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  }));
  const server = createMcpServer(runtime, { videoExporter: exporter });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "export-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const exportTool = tools.tools.find((tool) => tool.name === "timeline.export");
    assert.ok(exportTool);
    assert.deepEqual(Object.keys(exportTool.inputSchema.properties ?? {}).sort(), ["expected", "outputPath", "overwrite", "preset"]);

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.videoExport, true);

    const result = JSON.parse(textFrom(await client.callTool({
      name: "timeline.export",
      arguments: {
        outputPath,
        preset: "master",
        expected: { durationSeconds: 12, width: 1920, height: 1080, frameRate: 30, hasAudio: true },
      },
    })));
    assert.equal(result.verified, true);
    assert.equal(result.metadata.outputPath, outputPath);
    assert.equal(result.metadata.hasAudio, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP fails closed when video export is not configured", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Export Unavailable Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  }));
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "export-unavailable-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.videoExport, false);
    const result = await client.callTool({ name: "timeline.export", arguments: { outputPath: "/tmp/final.mp4", preset: "master" } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /CAPABILITY_UNAVAILABLE/);
  } finally {
    await client.close();
    await server.close();
  }
});
