import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, planDurationPolicy } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

test("duration planning recommends a shorter strong edit for ten minutes of requested time and four minutes of footage", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 10 * 60,
    footage: [{
      id: "usable-footage",
      durationSeconds: 4 * 60,
    }],
  });

  assert.equal(plan.policy.constraint, "soft");
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 4 * 60);
  assert.equal(plan.availableFootage.reusableDurationSeconds, 0);
  assert.equal(plan.achievableDurationSeconds, 4 * 60);
  assert.equal(plan.selectedAction, "deliver-shorter-strong-edit");
  assert.deepEqual(plan.durationReport, {
    requestedDurationSeconds: 10 * 60,
    achievableDurationSeconds: 4 * 60,
    actualDurationSeconds: null,
  });
  assert.equal(plan.unmetConstraints[0], "Requested duration exceeds unique usable footage");
  assert.ok(plan.alternatives.some((alternative) => alternative.kind === "request-additional-footage"));
  assert.deepEqual(plan.reusedRanges, []);
});

test("duration planning reports the requested duration when footage is abundant", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 60,
    footage: [{ id: "abundant-footage", durationSeconds: 120 }],
  });

  assert.equal(plan.selectedAction, "deliver-exact-duration");
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 120);
  assert.equal(plan.achievableDurationSeconds, 60);
  assert.equal(plan.durationReport.achievableDurationSeconds, 60);
});

test("hard duration planning uses explicitly permitted B-roll reuse and reports its source range", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 300,
    constraint: "hard",
    permissions: { allowReuse: true },
    footage: [
      {
        id: "b-roll",
        durationSeconds: 120,
        usableRanges: [{ startSeconds: 0, endSeconds: 120 }],
        reusable: true,
      },
      { id: "interview", durationSeconds: 60 },
    ],
    actualDurationSeconds: 300,
  });

  assert.equal(plan.selectedAction, "reuse-selected-b-roll");
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 180);
  assert.equal(plan.availableFootage.reusableDurationSeconds, 120);
  assert.equal(plan.achievableDurationSeconds, 300);
  assert.deepEqual(plan.reusedRanges, [{
    footageId: "b-roll",
    sourceRange: { startSeconds: 0, endSeconds: 120 },
    occurrence: 1,
  }]);
  assert.deepEqual(plan.unmetConstraints, []);
  assert.deepEqual(plan.durationReport, {
    requestedDurationSeconds: 300,
    achievableDurationSeconds: 300,
    actualDurationSeconds: 300,
  });
});

test("duration planning never silently selects slow motion or generated assets", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 300,
    permissions: { allowSlowMotion: true, allowGeneratedAssets: true },
    footage: [{ id: "footage", durationSeconds: 180 }],
  });

  assert.equal(plan.selectedAction, "deliver-shorter-strong-edit");
  assert.deepEqual(plan.reusedRanges, []);
  assert.equal(plan.alternatives.find((alternative) => alternative.kind === "slow-motion")?.status, "requires-confirmation");
  assert.equal(plan.alternatives.find((alternative) => alternative.kind === "generated-interstitial")?.status, "requires-confirmation");
});

test("duration planning counts disjoint usable ranges once and rejects overlapping or duplicate footage", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 120,
    footage: [{
      id: "interview",
      durationSeconds: 90,
      usableRanges: [
        { startSeconds: 0, endSeconds: 30 },
        { startSeconds: 60, endSeconds: 90 },
      ],
    }],
  });
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 60);

  assert.throws(
    () => planDurationPolicy({
      requestedDurationSeconds: 120,
      footage: [{
        id: "overlap",
        durationSeconds: 90,
        usableRanges: [
          { startSeconds: 0, endSeconds: 45 },
          { startSeconds: 30, endSeconds: 60 },
        ],
      }],
    }),
    /INVALID_DURATION_FOOTAGE: usable ranges overlap for overlap/,
  );
  assert.throws(
    () => planDurationPolicy({
      requestedDurationSeconds: 120,
      footage: [
        { id: "duplicate", durationSeconds: 60 },
        { id: "duplicate", durationSeconds: 60 },
      ],
    }),
    /INVALID_DURATION_FOOTAGE: duplicate footage id duplicate/,
  );
});

test("runtime duration planning is read-only and reports the observed actual duration", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "duration-policy-project",
    projectName: "Duration Policy Fixture",
    timelineId: "duration-policy-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "clip-1", name: "Footage", start: 0, duration: 120, track: 1 }],
  }));
  const before = await runtime.inspectProject();

  const plan = runtime.planDuration({
    requestedDurationSeconds: 180,
    actualDurationSeconds: 120,
    footage: [{ id: "footage", durationSeconds: 120 }],
  });

  assert.equal(plan.durationReport.actualDurationSeconds, 120);
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("MCP exposes an explicit duration planning contract", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "mcp-duration-policy-project",
    projectName: "MCP Duration Policy Fixture",
    timelineId: "mcp-duration-policy-timeline",
    timelineName: "Main Edit",
    clips: [],
  }));
  const server = createMcpServer(runtime);
  const client = new Client({ name: "duration-policy-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "editing.duration.plan");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["requestedDurationSeconds", "footage"]);

    const result = await client.callTool({
      name: "editing.duration.plan",
      arguments: {
        requestedDurationSeconds: 600,
        footage: [{ id: "footage", durationSeconds: 240 }],
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.content as Array<{ type?: string; text?: string }>;
    assert.equal(JSON.parse(content[0]!.text!).selectedAction, "deliver-shorter-strong-edit");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP and rough-cut documentation describe the same duration policy", async () => {
  const mcpDocumentation = await readFile(resolve("docs/mcp/tools.md"), "utf8");
  const roughCutDocumentation = await readFile(resolve("docs/rough-cut/duration-policy.md"), "utf8");

  assert.match(mcpDocumentation, /editing\.duration\.plan/);
  assert.match(mcpDocumentation, /soft constraint/i);
  assert.match(mcpDocumentation, /actualDurationSeconds/);
  assert.match(roughCutDocumentation, /ambiguous duration requests default to soft/i);
  assert.match(roughCutDocumentation, /never silently loops or slows/i);
  assert.match(roughCutDocumentation, /requested.*achievable.*actual/i);
});
