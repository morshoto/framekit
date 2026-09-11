import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type AddMaskOperation,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function maskFixture(options: { duplicate?: boolean } = {}) {
  const clips = [
    { id: "clip-subject", mediaId: "media-subject", name: "Subject", start: 0, duration: 10, track: 0 },
    ...(options.duplicate
      ? [{ id: "clip-subject", mediaId: "media-subject-2", name: "Duplicate", start: 0, duration: 10, track: 1 }]
      : []),
  ];
  return new InMemoryEditorAdapter({
    projectId: "project-mask",
    projectName: "Mask Fixture",
    timelineId: "timeline-mask",
    timelineName: "Main",
    clips,
    media: [
      {
        mediaId: "media-subject",
        source: "subject.mov",
        mediaKind: "video",
        duration: 10,
        sourceDigest: "sha256:subject",
      },
      {
        mediaId: "media-alpha",
        source: "subject-alpha.mov",
        mediaKind: "video",
        duration: 10,
        sourceDigest: "sha256:alpha",
      },
    ],
  });
}

function rectangleMask(): AddMaskOperation {
  return {
    type: "timeline.mask.add",
    occurrenceId: "clip-subject",
    mask: {
      mode: "rectangle",
      bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
      inverted: false,
    },
  };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

test("masking is independent from PIP and person cutout", async () => {
  const capabilities = await maskFixture().getCapabilities();

  assert.equal(capabilities.families?.editing.masking.available, true);
  assert.equal(capabilities.families?.editing.pictureInPicture.available, false);
  assert.equal(capabilities.families?.editing.personCutout.available, false);
});

test("mixed mask modes require both independent capabilities", async () => {
  const adapter = maskFixture();
  const getCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => {
    const capabilities = await getCapabilities();
    capabilities.editor.masking = false;
    capabilities.editor.personCutout = true;
    return capabilities;
  };
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewEdit({
      baseRevision: before.revision,
      operations: [
        rectangleMask(),
        { type: "timeline.mask.add", occurrenceId: "clip-subject", mask: { mode: "person-cutout" } },
      ],
    }),
    /CAPABILITY_UNAVAILABLE: masking/,
  );
});

test("mask preview is non-mutating and execution verifies diff and rollback", async () => {
  const adapter = maskFixture();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const operation = rectangleMask();

  const preview = await runtime.previewTimelineEdit(
    { projectId: before.projectId, sequenceId: before.timeline.id },
    { baseRevision: before.revision, operations: [operation] },
  );

  assert.deepEqual(await runtime.inspectProject(), before);
  assert.equal(preview.expectedDiff.modified[0]?.itemId, operation.occurrenceId);
  assert.deepEqual(preview.expectedDiff.modified[0]?.after?.mask, operation.mask);

  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(transaction.after.timeline.clips[0]?.mask, operation.mask);
  assert.equal(transaction.diff.modified[0]?.itemId, operation.occurrenceId);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "mask-state" && check.passed), true);

  const beforeDigest = canonicalSnapshotDigest(before);
  const restored = await runtime.undo(transaction.id);
  assert.equal(canonicalSnapshotDigest(restored), beforeDigest);
});

test("supplied-alpha masking requires and verifies an explicit video media identity", async () => {
  const runtime = new AgentVideoRuntime(maskFixture());
  const before = await runtime.inspectProject();
  const operation: AddMaskOperation = {
    type: "timeline.mask.add",
    occurrenceId: "clip-subject",
    mask: { mode: "supplied-alpha", alphaMediaId: "media-alpha", inverted: true },
  };

  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [operation],
  });
  const transaction = await runtime.executeEdit(preview.previewToken, { requireExpectedChange: true });

  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(transaction.after.timeline.clips[0]?.mask, operation.mask);
  assert.equal(transaction.baseRevision.id, before.revision.id);
});

test("unsupported and ambiguous mask targets fail closed before mutation", async () => {
  const unsupportedRuntime = new AgentVideoRuntime(maskFixture());
  const before = await unsupportedRuntime.inspectProject();

  await assert.rejects(
    unsupportedRuntime.previewEdit({
      baseRevision: before.revision,
      operations: [{
        type: "timeline.mask.add",
        occurrenceId: "clip-subject",
        mask: { mode: "person-cutout" },
      }],
    }),
    /CAPABILITY_UNAVAILABLE: person cutout/,
  );
  assert.equal(canonicalSnapshotDigest(await unsupportedRuntime.inspectProject()), canonicalSnapshotDigest(before));

  const ambiguousRuntime = new AgentVideoRuntime(maskFixture({ duplicate: true }));
  const ambiguousBefore = await ambiguousRuntime.inspectProject();
  await assert.rejects(
    ambiguousRuntime.previewEdit({ baseRevision: ambiguousBefore.revision, operations: [rectangleMask()] }),
    /AMBIGUOUS_MASK_TARGET/,
  );
  assert.equal(canonicalSnapshotDigest(await ambiguousRuntime.inspectProject()), canonicalSnapshotDigest(ambiguousBefore));
});

test("MCP exposes guarded masking preview, execute, diff, verify, and undo", async () => {
  const runtime = new AgentVideoRuntime(maskFixture());
  const server = createMcpServer(runtime);
  const client = new Client({ name: "masking-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.find((tool) => tool.name === "timeline.mask.add.preview"));
    assert.ok(tools.tools.find((tool) => tool.name === "timeline.mask.add.execute"));

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.mask.add" },
    })));
    assert.equal(route.status, "editor-selected");
    assert.ok(route.requiredCapabilities.includes("editor.masking"));

    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "timeline.mask.add.preview",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        occurrenceId: "clip-subject",
        mask: rectangleMask().mask,
      },
    })));
    assert.equal(preview.expectedDiff.modified[0].itemId, "clip-subject");

    const executed = JSON.parse(textFrom(await client.callTool({
      name: "timeline.mask.add.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(executed.status, "VERIFIED");
    assert.equal(executed.verification.checks.some((check: { name: string; passed: boolean }) => check.name === "mask-state" && check.passed), true);

    const diff = JSON.parse(textFrom(await client.callTool({ name: "edit.diff", arguments: { transactionId: executed.id } })));
    assert.equal(diff.modified[0].itemId, "clip-subject");
    const verification = JSON.parse(textFrom(await client.callTool({ name: "edit.verify", arguments: { transactionId: executed.id } })));
    assert.equal(verification.passed, true);
    const restored = JSON.parse(textFrom(await client.callTool({ name: "edit.undo", arguments: { transactionId: executed.id } })));
    assert.equal(restored.timeline.clips[0].mask, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
