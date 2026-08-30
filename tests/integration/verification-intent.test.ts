import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import {
  SILENT_AUDIO_FIXTURE,
  TOO_QUIET_AUDIO_FIXTURE,
  VALID_AUDIO_FIXTURE,
} from "../fixtures/semantic-audio.js";

function createRuntime(
  audio?: { integratedLufs: number; truePeakDb: number; silenceMs: number; audibleSamples?: number; analyzedDurationSeconds?: number },
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
    ...SILENT_AUDIO_FIXTURE,
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
    ...VALID_AUDIO_FIXTURE,
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
    ...VALID_AUDIO_FIXTURE,
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
    VALID_AUDIO_FIXTURE,
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
    ...VALID_AUDIO_FIXTURE,
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
  const runtime = createRuntime({ ...VALID_AUDIO_FIXTURE, audibleSamples: undefined, analyzedDurationSeconds: undefined }, undefined, null);

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

test("semantic audibility prefers analyzed duration over asset duration", async () => {
  const runtime = createRuntime({
    ...SILENT_AUDIO_FIXTURE,
    audibleSamples: undefined,
    silenceMs: 2_000,
    analyzedDurationSeconds: 1,
  });

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    { assertions: [{ type: "audio-audibility", mediaId: "rain" }] },
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-audibility")?.reason, "AUDIO_NOT_AUDIBLE");
});

test("semantic audibility accepts analyzed duration without asset duration", async () => {
  const runtime = createRuntime({ ...VALID_AUDIO_FIXTURE, audibleSamples: undefined }, undefined, null);

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    { assertions: [{ type: "audio-audibility", mediaId: "rain" }] },
  );

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-audibility")?.status, "passed");
});

test("semantic verification distinguishes missing media from missing analysis", async () => {
  const runtime = createRuntime(VALID_AUDIO_FIXTURE);

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    { assertions: [{ type: "audio-loudness", mediaId: "missing", targetLufs: -18 }] },
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-loudness")?.reason, "MEDIA_NOT_FOUND");
});

test("runtime rejects invalid semantic assertion values before mutation", async () => {
  const runtime = createRuntime(VALID_AUDIO_FIXTURE);
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.edit(
      { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
      { assertions: [{ type: "audio-loudness", mediaId: "rain", targetLufs: -18, toleranceDb: Number.POSITIVE_INFINITY }] },
    ),
    /INVALID_VERIFICATION_POLICY/,
  );
  const after = await runtime.inspectProject();
  assert.deepEqual(after.timeline, before.timeline);
  assert.deepEqual(after.media, before.media);
});

test("edit verification uses one immutable policy snapshot", async () => {
  const runtime = createRuntime(SILENT_AUDIO_FIXTURE);
  const policy = { assertions: [{ type: "audio-audibility" as const, mediaId: "rain", minAudibleSamples: 1 }] };
  const edit = runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    policy,
  );
  policy.assertions = [];

  const transaction = await edit;
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.deepEqual(transaction.verificationPolicy, {
    assertions: [{ type: "audio-audibility", mediaId: "rain", minAudibleSamples: 1 }],
  });
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-audibility")?.reason, "AUDIO_NOT_AUDIBLE");
});

test("composite previews retain semantic policies through verified execution", async () => {
  const runtime = createRuntime({
    ...SILENT_AUDIO_FIXTURE,
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
    ...SILENT_AUDIO_FIXTURE,
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

test("semantic loudness rejects a deterministic too-quiet ambience", async () => {
  const runtime = createRuntime(TOO_QUIET_AUDIO_FIXTURE);

  const transaction = await runtime.edit(
    { type: "rename-clip", clipId: "rain-clip", name: "Rain ambience" },
    {
      assertions: [{ type: "audio-loudness", mediaId: "rain", targetLufs: -18, toleranceDb: 0.5 }],
    },
  );

  assert.equal(transaction.status, "ROLLED_BACK");
  const check = transaction.verification?.checks.find((candidate) => candidate.name === "audio-loudness");
  assert.equal(check?.reason, "AUDIO_LOUDNESS_OUT_OF_RANGE");
  assert.equal(check?.observed, -42);
});

test("music previews retain semantic policies until execution", async () => {
  const runtime = createRuntime(SILENT_AUDIO_FIXTURE);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewMusic({
    baseRevision: before.revision,
    occurrenceId: "rain-music-copy",
    mediaId: "rain",
    placement: "append",
    duration: 10,
    targetLane: -2,
    verification: { assertions: [{ type: "audio-audibility", mediaId: "rain" }] },
  });

  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "audio-audibility")?.reason, "AUDIO_NOT_AUDIBLE");
  const after = await runtime.inspectProject();
  assert.deepEqual(after.timeline, before.timeline);
  assert.deepEqual(after.media, before.media);
});
