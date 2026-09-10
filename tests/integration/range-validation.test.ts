import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  type VisualAnalyzer,
} from "@framekit/runtime";
import {
  FixtureVisualAnalyzer,
  InMemoryEditorAdapter,
} from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = (content[0] as { text?: unknown } | undefined)?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

function createRangeRuntime(counters: { projectReads: number; visualCalls: number }): AgentVideoRuntime {
  const adapter = new InMemoryEditorAdapter({
    projectId: "range-validation-project",
    projectName: "Range Validation",
    timelineId: "range-validation-timeline",
    timelineName: "Main Edit",
    clips: [],
    media: [{
      mediaId: "media-1",
      source: "interview.mov",
      visual: {
        scenes: [{ id: "scene-1", start: 0, end: 10, label: "interview" }],
        subjects: [],
        keyframes: [],
      },
    }],
  });
  const readProject = adapter.readProject.bind(adapter);
  adapter.readProject = async () => {
    counters.projectReads += 1;
    return readProject();
  };
  const fixtureAnalyzer = new FixtureVisualAnalyzer();
  const visualAnalyzer: VisualAnalyzer = {
    descriptor: fixtureAnalyzer.descriptor,
    analyze: async (input, range) => {
      counters.visualCalls += 1;
      return fixtureAnalyzer.analyze(input, range);
    },
  };
  return new AgentVideoRuntime(adapter, { visualAnalyzer });
}

async function connectRangeServer(counters: { projectReads: number; visualCalls: number }) {
  const server = createMcpServer(createRangeRuntime(counters));
  const client = new Client({ name: "range-validation-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("analysis and planning tools reject non-increasing ranges before execution", async () => {
  const counters = { projectReads: 0, visualCalls: 0 };
  const { client, server } = await connectRangeServer(counters);
  const invalidRanges = [
    { start: 5, end: 1 },
    { start: 1, end: 1 },
  ];

  try {
    for (const range of invalidRanges) {
      for (const request of [
        { name: "media.index", arguments: { range } },
        { name: "rough-cut.plan", arguments: { range } },
        { name: "visual.analyze", arguments: { mediaId: "media-1", range } },
      ]) {
        const result = await client.callTool(request);
        assert.equal(result.isError, true, request.name);
        assert.match(textFrom(result), /end must be greater than start/);
      }
    }
    assert.equal(counters.projectReads, 0);
    assert.equal(counters.visualCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("analysis and planning tools accept strictly increasing ranges", async () => {
  const counters = { projectReads: 0, visualCalls: 0 };
  const { client, server } = await connectRangeServer(counters);

  try {
    const range = { start: 1, end: 5 };
    const index = await client.callTool({ name: "media.index", arguments: { range } });
    assert.equal(index.isError, undefined);
    const plan = await client.callTool({ name: "rough-cut.plan", arguments: { range } });
    assert.equal(plan.isError, undefined);
    const visual = await client.callTool({
      name: "visual.analyze",
      arguments: { mediaId: "media-1", range },
    });
    assert.equal(visual.isError, undefined);
    assert.equal(counters.projectReads, 3);
    assert.equal(counters.visualCalls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
