import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function createRuntime(
  audio?: { integratedLufs: number; truePeakDb: number; silenceMs: number; audibleSamples?: number },
  visual?: { scenes: Array<{ id: string; start: number; end: number; label?: string; confidence?: number }>; subjects: Array<{ id: string; label: string; confidence: number }>; keyframes: [] },
  mediaDuration: number | null = 10,
) {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "verification-project",
    projectName: "Verification Fixture",
    timelineId: "verification-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "rain-clip", mediaId: "rain", name: "Rain", start: 0, duration: 10, track: -1 }],
    media: [{
      mediaId: "rain",
      source: "rain.wav",
      mediaKind: "audio",
      ...(mediaDuration === null ? {} : { duration: mediaDuration }),
      sourceDigest: "sha256:rain",
      ...(audio ? { audio } : {}),
      ...(visual ? { visual } : {}),
    }],
  }));
}

test("semantic audio audibility rejects silent audio with an audio stream", async () => {
  const runtime = createRuntime({
    integratedLufs: -80,
    truePeakDb: -80,
    silenceMs: 10_000,
    audibleSamples: 0,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-audibility");
  assert.deepEqual(check, {
    name: "audio-audibility",
    passed: false,
    status: "failed",
    expected: { mediaId: "rain", minAudibleSamples: 1 },
    observed: { mediaId: "rain", audibleSamples: 0, silenceMs: 10_000 },
    reason: "AUDIO_NOT_AUDIBLE",
    detail: "expected audible audio samples, observed none",
  });
});

test("semantic audio assertions verify coverage, loudness, and source identity", async () => {
  const runtime = createRuntime({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 120,
    audibleSamples: 1_000,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [
        { type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 },
        { type: "audio-coverage", mediaId: "rain", start: 0, duration: 10 },
        { type: "audio-loudness", mediaId: "rain", targetLufs: -18, toleranceDb: 0.5 },
        { type: "audio-source", mediaId: "rain", sourceDigest: "sha256:rain" },
      ],
    } as never,
  );

  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    transaction.verification?.checks
      .filter((check) => ["audio-audibility", "audio-coverage", "audio-loudness", "audio-source"].includes(check.name))
      .map((check) => check.name),
    ["audio-audibility", "audio-coverage", "audio-loudness", "audio-source"],
  );
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-loudness")?.observed, -18);
});

test("semantic audio coverage rejects an ambience shorter than requested", async () => {
  const runtime = createRuntime({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 120,
    audibleSamples: 1_000,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-coverage", mediaId: "rain", start: 0, duration: 11 }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-coverage");
  assert.equal(check?.reason, "AUDIO_COVERAGE_INCOMPLETE");
  assert.deepEqual(check?.expected, { mediaId: "rain", start: 0, duration: 11, toleranceSeconds: 0 });
});

test("semantic verification checks visual, duration, stream, and structure expectations", async () => {
  const runtime = createRuntime(
    { integratedLufs: -18, truePeakDb: -3, silenceMs: 120, audibleSamples: 1_000 },
    {
      scenes: [{ id: "scene-rain", start: 0, end: 10, label: "rain", confidence: 0.99 }],
      subjects: [],
      keyframes: [],
    },
  );

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [
        { type: "visual-content", mediaId: "rain", label: "rain", labelKind: "scene", minConfidence: 0.9 },
        { type: "duration", target: "timeline", expectedSeconds: 10 },
        { type: "stream", target: "audio", expected: true },
        { type: "structure", requirement: "occurrence-present", occurrenceId: "rain-clip" },
        { type: "structure", requirement: "operation-present", operationType: "rename-clip" },
      ],
    } as never,
  );

  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    transaction.verification?.checks.slice(-5).map((check) => ({ name: check.name, status: check.status })),
    [
      { name: "visual-content", status: "passed" },
      { name: "duration", status: "passed" },
      { name: "stream", status: "passed" },
      { name: "structure", status: "passed" },
      { name: "structure", status: "passed" },
    ],
  );
});

test("semantic verification fails closed when a requested analyzer is unavailable", async () => {
  const runtime = createRuntime({
    integratedLufs: -18,
    truePeakDb: -3,
    silenceMs: 120,
    audibleSamples: 1_000,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "visual-content", mediaId: "rain", label: "rain" }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "visual-content");
  assert.equal(check?.passed, false);
  assert.equal(check?.status, "unavailable");
  assert.equal(check?.reason, "VISUAL_ANALYZER_UNAVAILABLE");
});

test("semantic audibility does not infer success without duration evidence", async () => {
  const runtime = createRuntime({ integratedLufs: -18, truePeakDb: -3, silenceMs: 0 }, undefined, null);

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-audibility", mediaId: "rain" }],
    } as never,
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-audibility");
  assert.equal(check?.status, "unavailable");
  assert.equal(check?.reason, "AUDIO_ANALYZER_UNAVAILABLE");
});

test("composite previews retain semantic policies through verified execution", async () => {
  const runtime = createRuntime({
    integratedLufs: -80,
    truePeakDb: -80,
    silenceMs: 10_000,
    audibleSamples: 0,
  });
  const before = await runtime.inspectProject();
  const verification = {
    assertions: [{ type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 }],
  };

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{ type: "set-gain", clipId: "rain-clip", gainDb: -6 }],
    verification,
  } as never);

  assert.deepEqual((preview as never as { verification?: unknown }).verification, verification);
  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.deepEqual(transaction.verificationPolicy, verification);
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-audibility")?.reason, "AUDIO_NOT_AUDIBLE");
});

test("MCP carries semantic verification assertions through a timeline edit", async () => {
  const server = createMcpServer(createRuntime({
    integratedLufs: -80,
    truePeakDb: -80,
    silenceMs: 10_000,
    audibleSamples: 0,
  }));
  const client = new Client({ name: "verification-intent-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    const timelineEdit = tools.tools.find((tool) => tool.name === "timeline.edit");
    assert.ok(timelineEdit);
    assert.ok(Object.keys(timelineEdit.inputSchema.properties ?? {}).includes("verification"));

    const result = await client.callTool({
      name: "timeline.edit",
      arguments: {
        type: "rename-clip",
        clipId: "rain-clip",
        name: "Rain ambience",
        verification: {
          assertions: [{ type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 }],
        },
      },
    });
    assert.equal(result.isError, undefined);
    const content = result.content as Array<{ text?: string }>;
    const transaction = JSON.parse(content[0]?.text ?? "{}");
    assert.equal(transaction.status, "ROLLED_BACK");
    assert.equal(transaction.verification.checks.at(-1).reason, "AUDIO_NOT_AUDIBLE");
  } finally {
    await client.close();
    await server.close();
  }
});
