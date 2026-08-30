import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import type { VerificationEngine, WorkflowOperation } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function createCompositeRuntime(options: ConstructorParameters<typeof AgentVideoRuntime>[1] = {}) {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-mvp",
    projectName: "Basic Editing MVP",
    timelineId: "timeline-mvp",
    timelineName: "Main Edit",
    clips: [],
    media: [],
    assets: [{
      id: "title-basic",
      kind: "title",
      name: "Basic Title",
      vendor: "Framekit Fixture",
      metadata: {},
    }],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter, options) };
}

function workflowOperations(): WorkflowOperation[] {
  return [
    {
      type: "media.import" as const,
      mediaId: "media-video",
      source: "/fixtures/interview.mov",
      mediaKind: "video" as const,
      duration: 12,
      sourceDigest: "sha256:video",
    },
    {
      type: "media.import" as const,
      mediaId: "media-music",
      source: "/fixtures/music.wav",
      mediaKind: "audio" as const,
      duration: 8,
      sourceDigest: "sha256:music",
    },
    {
      type: "timeline.media.add" as const,
      occurrenceId: "clip-video",
      mediaId: "media-video",
      role: "video" as const,
      start: 0,
      duration: 12,
      targetLane: "primary" as const,
    },
    {
      type: "trim-clip" as const,
      clipId: "clip-video",
      duration: 8,
    },
    {
      type: "timeline.media.add" as const,
      occurrenceId: "clip-music",
      mediaId: "media-music",
      role: "music" as const,
      start: 0,
      duration: 8,
      targetLane: -1,
    },
    {
      type: "timeline.title.add" as const,
      occurrenceId: "title-opening",
      assetId: "title-basic",
      text: "Framekit MVP",
      start: 1,
      duration: 3,
      targetLane: 1,
    },
  ];
}

function projectContent(snapshot: Awaited<ReturnType<AgentVideoRuntime["inspectProject"]>>) {
  return { projectId: snapshot.projectId, timeline: snapshot.timeline, media: snapshot.media };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

test("composite preview is non-mutating and execute applies the ordered MVP workflow once", async () => {
  const { runtime } = createCompositeRuntime();
  const before = await runtime.inspectProject();

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: workflowOperations(),
  });

  assert.match(preview.previewToken, /^preview-/);
  assert.equal(preview.expectedDiff.added.length, 3);
  assert.equal(preview.expectedDiff.mediaChanges.length, 2);
  assert.equal(preview.expectedDiff.durationDelta, 8);
  assert.deepEqual(preview.expectedDiff.durationDeltaTime, { value: "8", timescale: "1" });
  assert.equal(preview.expectedDiff.to.timestamp, new Date(1).toISOString());
  assert.deepEqual(await runtime.inspectProject(), before);

  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.planned.length, 6);
  assert.deepEqual(transaction.applied, transaction.planned);
  assert.deepEqual(transaction.after.timeline.clips.map((clip) => clip.id), [
    "clip-video",
    "clip-music",
    "title-opening",
  ]);
  assert.equal(transaction.after.timeline.clips[0]?.duration, 8);
  assert.deepEqual(transaction.after.timeline.durationTime, { value: "8", timescale: "1" });
  assert.deepEqual(transaction.diff, preview.expectedDiff);
  assert.deepEqual(transaction.after.media.map((media) => media.mediaId), ["media-video", "media-music"]);
  assert.equal(transaction.diff.affectedRanges.length > 0, true);
  assert.equal(transaction.verification?.passed, true);

  const undone = await runtime.undo(transaction.id);
  assert.deepEqual(projectContent(undone), projectContent(before));
  assert.equal(undone.revision.timestamp, new Date(2).toISOString());
});

test("media-only composite transactions count registry changes during verification", async () => {
  const { runtime } = createCompositeRuntime();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [workflowOperations()[0]!],
  });

  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.diff.added.length, 0);
  assert.equal(transaction.diff.mediaChanges.length, 1);
  assert.equal(transaction.after.media[0]?.mediaId, "media-video");
});

test("composite preview storage evicts the oldest active token at its configured bound", async () => {
  const { runtime } = createCompositeRuntime({ maxActivePreviews: 2 });
  const before = await runtime.inspectProject();
  const first = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  const second = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  const third = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });

  await assert.rejects(runtime.executeEdit(first.previewToken), /PREVIEW_TOKEN_INVALID/);
  assert.match(second.previewToken, /^preview-/);
  assert.match(third.previewToken, /^preview-/);
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("composite operations reject non-finite imported and placement timing", async () => {
  const mutations: Array<(operations: WorkflowOperation[]) => void> = [
    (operations) => {
      const imported = operations.find((operation) => operation.type === "media.import");
      if (imported?.type === "media.import") imported.duration = Number.NaN;
    },
    (operations) => {
      const placement = operations.find((operation) => operation.type === "timeline.media.add");
      if (placement?.type === "timeline.media.add") placement.start = Number.NaN;
    },
    (operations) => {
      const title = operations.find((operation) => operation.type === "timeline.title.add");
      if (title?.type === "timeline.title.add") title.duration = Number.NaN;
    },
  ];

  for (const mutate of mutations) {
    const { runtime } = createCompositeRuntime();
    const before = await runtime.inspectProject();
    const operations = workflowOperations();
    mutate(operations);
    await assert.rejects(runtime.previewEdit({ baseRevision: before.revision, operations }), /INVALID_OPERATION/);
    assert.deepEqual(await runtime.inspectProject(), before);
  }
});

test("composite execute consumes tokens and rejects stale, expired, and unavailable workflows before mutation", async () => {
  let now = 1_000;
  const { adapter, runtime } = createCompositeRuntime({ now: () => now, previewTtlMs: 10 });
  const before = await runtime.inspectProject();
  const expired = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  now = 1_011;
  await assert.rejects(runtime.executeEdit(expired.previewToken), /PREVIEW_TOKEN_EXPIRED/);
  assert.deepEqual(await runtime.inspectProject(), before);

  const stale = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  await runtime.edit({
    type: "add-marker",
    timelineId: "timeline-mvp",
    marker: { id: "marker-external", start: 0, duration: 0, name: "External change" },
  });
  const afterExternalChange = await runtime.inspectProject();
  await assert.rejects(runtime.executeEdit(stale.previewToken), /STALE_CONTEXT/);
  assert.deepEqual(await runtime.inspectProject(), afterExternalChange);

  const originalCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => ({
    ...await originalCapabilities(),
    editor: { ...(await originalCapabilities()).editor, mediaImport: false },
  });
  await assert.rejects(
    runtime.previewEdit({ baseRevision: afterExternalChange.revision, operations: workflowOperations() }),
    /CAPABILITY_UNAVAILABLE: media import/,
  );
  assert.deepEqual(await runtime.inspectProject(), afterExternalChange);
});

test("title placement requires timeline mutation capability", async () => {
  const { adapter, runtime } = createCompositeRuntime();
  const before = await runtime.inspectProject();
  const originalCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => ({
    ...await originalCapabilities(),
    editor: {
      ...(await originalCapabilities()).editor,
      timelineWrite: false,
      timelineArtifactWrite: false,
    },
  });

  await assert.rejects(
    runtime.previewEdit({ baseRevision: before.revision, operations: [workflowOperations()[5]!] }),
    /CAPABILITY_UNAVAILABLE: editor timeline mutation/,
  );
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("composite execute is single-use and rolls back timeline and media after failed verification", async () => {
  const failingVerification: VerificationEngine = {
    verify: async () => ({
      passed: false,
      checks: [{ name: "fixture-failure", passed: false, detail: "forced verification failure" }],
    }),
  };
  const { runtime } = createCompositeRuntime({ verificationEngine: failingVerification });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });

  const transaction = await runtime.executeEdit(preview.previewToken);

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.attemptedAfter.media.length, 2);
  assert.deepEqual(projectContent(transaction.after), projectContent(before));
  assert.deepEqual(projectContent(await runtime.inspectProject()), projectContent(before));
  await assert.rejects(runtime.executeEdit(preview.previewToken), /PREVIEW_TOKEN_INVALID/);
});

test("composite execute restores canonical state when verification throws", async () => {
  const throwingVerification: VerificationEngine = {
    verify: async () => { throw new Error("FIXTURE_VERIFICATION_ERROR"); },
  };
  const { runtime } = createCompositeRuntime({ verificationEngine: throwingVerification });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });

  await assert.rejects(
    runtime.executeEdit(preview.previewToken),
    /VERIFICATION_FAILED: canonical state was restored.*FIXTURE_VERIFICATION_ERROR/,
  );
  assert.deepEqual(projectContent(await runtime.inspectProject()), projectContent(before));
});

test("composite execute rejects a failed-verification rollback that does not restore canonical state", async () => {
  const failingVerification: VerificationEngine = {
    verify: async () => ({
      passed: false,
      checks: [{ name: "fixture-failure", passed: false, detail: "forced verification failure" }],
    }),
  };
  const { adapter, runtime } = createCompositeRuntime({ verificationEngine: failingVerification });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  adapter.restore = async () => {};

  await assert.rejects(runtime.executeEdit(preview.previewToken), /ROLLBACK_FAILED/);
});

test("composite execute rejects an analysis rollback that does not restore canonical state", async () => {
  const { adapter, runtime } = createCompositeRuntime({
    speechAnalyzer: { analyze: async () => { throw new Error("FIXTURE_ANALYSIS_ERROR"); } },
  });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  adapter.restore = async () => {};

  await assert.rejects(runtime.executeEdit(preview.previewToken), /ROLLBACK_FAILED/);
});

test("composite execute compensates for an adapter failure after a partial write", async () => {
  const { adapter, runtime } = createCompositeRuntime();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: workflowOperations() });
  const applyTransaction = adapter.applyTransaction.bind(adapter);
  adapter.applyTransaction = async (operations, expectedRevision) => {
    await applyTransaction(operations.slice(0, 1), expectedRevision);
    throw new Error("FIXTURE_PARTIAL_WRITE");
  };

  await assert.rejects(runtime.executeEdit(preview.previewToken), /TRANSACTION_FAILED.*FIXTURE_PARTIAL_WRITE/);
  assert.deepEqual(projectContent(await runtime.inspectProject()), projectContent(before));
});

test("MCP exposes one composite preview and execute contract with workflow operation schemas", async () => {
  const { runtime } = createCompositeRuntime();
  const server = createMcpServer(runtime);
  const client = new Client({ name: "composite-edit-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "timeline.edit.preview"));
    assert.ok(tools.tools.some((tool) => tool.name === "timeline.edit.execute"));

    const before = await runtime.inspectProject();
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit.preview",
      arguments: { baseRevision: before.revision, operations: workflowOperations() },
    })));
    assert.match(preview.previewToken, /^preview-/);
    assert.deepEqual(await runtime.inspectProject(), before);

    const executed = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(executed.status, "VERIFIED");
    assert.equal(executed.diff.added.length, 3);
    assert.equal(executed.diff.mediaChanges.length, 2);

    const invalid = await client.callTool({
      name: "timeline.edit.preview",
      arguments: {
        baseRevision: executed.after.revision,
        operations: [{
          type: "timeline.media.add",
          occurrenceId: "invalid-music",
          mediaId: "media-music",
          role: "music",
          start: 0,
          duration: 1,
          targetLane: "primary",
        }],
      },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
