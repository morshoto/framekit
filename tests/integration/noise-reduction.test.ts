import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type NoiseAnalyzer,
  type RuntimeCapabilities,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function fixture(): InMemoryEditorAdapter {
  return new InMemoryEditorAdapter({
    projectId: "noise-project",
    projectName: "Noise Reduction",
    timelineId: "noise-timeline",
    timelineName: "Main",
    clips: [{
      id: "noise-occurrence",
      mediaId: "noise-media",
      name: "Interview audio",
      start: 0,
      duration: 4,
      track: 1,
      role: "audio",
    }],
    media: [{
      mediaId: "noise-media",
      source: "/fixtures/interview.wav",
      mediaKind: "audio",
      duration: 4,
      audio: { integratedLufs: -20, truePeakDb: -3, silenceMs: 0 },
    }],
  });
}

const noiseAnalyzer: NoiseAnalyzer = {
  descriptor: { id: "fixture.noise", provider: "deterministic-testkit", version: "1" },
  analyze: async ({ project, media }) => {
    const clip = project.timeline.clips.find((candidate) => candidate.mediaId === media.mediaId);
    const reductionDb = clip?.noiseReductionDb ?? 0;
    return {
      noiseFloorDb: -30 - reductionDb,
      peakNoiseDb: -20 - reductionDb,
      affectedRanges: [{ start: 1, end: 3 }],
      recommendedReductionDb: 18,
      confidence: 0.98,
      valid: true,
    };
  },
};

function textFrom(value: unknown): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return content?.[0]?.text ?? "";
}

function request(baseRevision: { id: string; sequence: number; timestamp: string }) {
  return {
    ...input(),
    baseRevision,
  };
}

function input() {
  return {
    mediaId: "noise-media",
    occurrenceId: "noise-occurrence",
    noiseThresholdDb: -45,
    maxReductionDb: 18,
    minConfidence: 0.8,
  };
}

test("noise analysis previews affected ranges, verifies post-write measurement, and supports Undo", async () => {
  const adapter = fixture();
  const runtime = new AgentVideoRuntime(adapter, { noiseAnalyzer });
  runtime.registerBuiltinSkills();
  const before = await runtime.inspectProject();
  const measurement = await runtime.analyzeNoise("noise-media", { start: 0, end: 4 });
  assert.equal(measurement.noiseFloorDb, -30);
  assert.deepEqual(measurement.affectedRanges, [{ start: 1, end: 3 }]);

  const preview = await runtime.previewSkill({
    skillId: "audio-noise-reduction",
    baseRevision: before.revision,
    input: input(),
  });
  assert.deepEqual(preview.plan.details?.timelineAffectedRanges, [{ start: 1, end: 3 }]);
  assert.equal(preview.plan.operations[0]?.type, "reduce-noise");
  assert.deepEqual(await runtime.inspectProject(), before);

  const execution = await runtime.executeSkill(preview.previewToken);
  assert.equal(execution.status, "VERIFIED");
  assert.equal(execution.verification?.checks.some((check) => check.name === "audio-noise" && check.passed), true);
  assert.equal(execution.diff?.modified.some((change) => change.itemId === "noise-occurrence"), true);
  const after = await runtime.inspectProject();
  assert.equal(after.timeline.clips.find((clip) => clip.id === "noise-occurrence")?.noiseReductionDb, 18);

  const transactionId = execution.transactionIds[0];
  assert.ok(transactionId);
  const restored = await runtime.undo(transactionId);
  assert.equal(canonicalSnapshotDigest(restored), canonicalSnapshotDigest(before));
  assert.ok(restored.revision.sequence > before.revision.sequence);
});

test("noise reduction MCP tools expose analysis and token-backed preview/execute", async () => {
  const runtime = new AgentVideoRuntime(fixture(), { noiseAnalyzer });
  const server = createMcpServer(runtime);
  const client = new Client({ name: "noise-reduction-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "audio.noise.analyze"));
    const analysis = JSON.parse(textFrom(await client.callTool({
      name: "audio.noise.analyze",
      arguments: { mediaId: "noise-media" },
    }))) as { noiseFloorDb: number };
    assert.equal(analysis.noiseFloorDb, -30);
    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))) as {
      revision: { id: string; sequence: number; timestamp: string };
    };
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "audio.noise.reduce.preview",
      arguments: request(before.revision),
    }))) as { previewToken: string; plan: { details?: { timelineAffectedRanges?: unknown[] } } };
    assert.deepEqual(preview.plan.details?.timelineAffectedRanges, [{ start: 1, end: 3 }]);
    const execution = JSON.parse(textFrom(await client.callTool({
      name: "audio.noise.reduce.execute",
      arguments: { previewToken: preview.previewToken },
    }))) as { status: string; verification?: { checks: Array<{ name: string; passed: boolean }> } };
    assert.equal(execution.status, "VERIFIED");
    assert.equal(execution.verification?.checks.some((check) => check.name === "audio-noise" && check.passed), true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("noise reduction fails closed without an analyzer or effect capability", async () => {
  const noAnalyzer = new AgentVideoRuntime(fixture());
  noAnalyzer.registerBuiltinSkills();
  await assert.rejects(noAnalyzer.analyzeNoise("noise-media"), /CAPABILITY_UNAVAILABLE: audio noise analysis/);
  const unavailable = await noAnalyzer.listSkillAvailability();
  const noiseSkill = unavailable.find((skill) => skill.manifest.id === "audio-noise-reduction");
  assert.equal(noiseSkill?.availability.available, false);
  assert.ok(noiseSkill?.availability.reasonCodes.includes("MISSING_ANALYZER_CAPABILITY"));

  const blockedAdapter = fixture();
  const originalGetCapabilities = blockedAdapter.getCapabilities.bind(blockedAdapter);
  blockedAdapter.getCapabilities = async (): Promise<RuntimeCapabilities> => {
    const capabilities = await originalGetCapabilities();
    return {
      ...capabilities,
      editor: {
        ...capabilities.editor,
        noiseReduction: false,
        semanticOperations: { ...capabilities.editor.semanticOperations, "reduce-noise": false },
      },
    };
  };
  const blocked = new AgentVideoRuntime(blockedAdapter, { noiseAnalyzer });
  blocked.registerBuiltinSkills();
  const before = await blocked.inspectProject();
  await assert.rejects(
    blocked.previewSkill({ skillId: "audio-noise-reduction", baseRevision: before.revision, input: input() }),
    /SKILL_REQUIREMENTS_UNMET/,
  );
});
