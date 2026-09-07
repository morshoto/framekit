import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type RuntimeCapabilities,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function fixture(): InMemoryEditorAdapter {
  return new InMemoryEditorAdapter({
    projectId: "color-project",
    projectName: "Color Correction",
    timelineId: "color-timeline",
    timelineName: "Main",
    clips: [
      { id: "target-clip", mediaId: "target-media", name: "Target", start: 0, duration: 4, track: 0, role: "video" },
      { id: "other-clip", mediaId: "other-media", name: "Other", start: 4, duration: 4, track: 0, role: "video" },
    ],
    media: [
      { mediaId: "target-media", source: "/fixtures/target.mov", mediaKind: "video", duration: 4 },
      { mediaId: "other-media", source: "/fixtures/other.mov", mediaKind: "video", duration: 4 },
    ],
  });
}

function input() {
  return {
    clipId: "target-clip",
    preset: "warm" as const,
    exposure: 0.5,
    contrast: 0.2,
    saturation: 0.15,
    temperature: 25,
    tint: -3,
  };
}

function textFrom(value: unknown): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return content?.[0]?.text ?? "";
}

test("color correction previews before/after values, targets one clip, verifies, and supports Undo", async () => {
  const adapter = fixture();
  const runtime = new AgentVideoRuntime(adapter);
  runtime.registerBuiltinSkills();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewSkill({
    skillId: "color-correction",
    baseRevision: before.revision,
    input: input(),
  });
  assert.deepEqual(preview.plan.details?.before, {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
  });
  assert.deepEqual(preview.plan.details?.after, {
    exposure: 0.5,
    contrast: 0.2,
    saturation: 0.15,
    temperature: 25,
    tint: -3,
    preset: "warm",
  });
  assert.equal(preview.plan.operations[0]?.type, "set-color-correction");
  assert.equal((preview.plan.operations[0] as { clipId: string }).clipId, "target-clip");
  assert.deepEqual(await runtime.inspectProject(), before);

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.verification?.checks.some((check) => check.name === "color-correction" && check.passed), true);
  assert.deepEqual(execution.diff?.modified.map((change) => change.itemId), ["target-clip"]);
  const after = await runtime.inspectProject();
  assert.deepEqual(after.timeline.clips.find((clip) => clip.id === "target-clip")?.colorCorrection, {
    exposure: 0.5,
    contrast: 0.2,
    saturation: 0.15,
    temperature: 25,
    tint: -3,
    preset: "warm",
  });
  assert.equal(after.timeline.clips.find((clip) => clip.id === "other-clip")?.colorCorrection, undefined);

  const transactionId = execution.transactionIds[0];
  assert.ok(transactionId);
  const restored = await runtime.undo(transactionId);
  assert.equal(canonicalSnapshotDigest(restored), canonicalSnapshotDigest(before));
});

test("color correction MCP tools use the generic token contract", async () => {
  const server = createMcpServer(new AgentVideoRuntime(fixture()));
  const client = new Client({ name: "color-correction-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))) as {
      revision: { id: string; sequence: number; timestamp: string };
    };
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "color.correction.preview",
      arguments: { ...input(), baseRevision: before.revision },
    }))) as { previewToken: string; plan: { details?: { before?: unknown; after?: unknown } } };
    assert.equal((preview.plan.details?.after as { temperature?: number }).temperature, 25);
    const execution = JSON.parse(textFrom(await client.callTool({
      name: "color.correction.execute",
      arguments: { previewToken: preview.previewToken },
    }))) as { status: string };
    assert.equal(execution.status, "VERIFIED");
  } finally {
    await client.close();
    await server.close();
  }
});

test("color correction fails closed when the editor does not advertise the effect", async () => {
  const adapter = fixture();
  const originalGetCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async (): Promise<RuntimeCapabilities> => {
    const capabilities = await originalGetCapabilities();
    return {
      ...capabilities,
      editor: {
        ...capabilities.editor,
        colorCorrection: false,
        semanticOperations: { ...capabilities.editor.semanticOperations, "set-color-correction": false },
      },
    };
  };
  const runtime = new AgentVideoRuntime(adapter);
  runtime.registerBuiltinSkills();
  const before = await runtime.inspectProject();
  const availability = await runtime.inspectSkillAvailability("color-correction");
  assert.equal(availability.availability.available, false);
  assert.ok(availability.availability.reasonCodes.includes("MISSING_EDITOR_CAPABILITY"));
  await assert.rejects(
    runtime.previewSkill({ skillId: "color-correction", baseRevision: before.revision, input: input() }),
    /SKILL_REQUIREMENTS_UNMET/,
  );
});
