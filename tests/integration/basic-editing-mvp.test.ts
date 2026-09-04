import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FinalCutVideoExporter } from "@framekit/final-cut";
import { AgentVideoRuntime, canonicalSnapshotDigest } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { BASIC_EDITING_MVP_FIXTURE, BASIC_MVP_FIXTURE_BYTES, BASIC_MVP_MEDIA, BASIC_MVP_TITLE_ASSET } from "../fixtures/basic-editing-mvp.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const contractPath = resolve("docs/final-cut/basic-editing-mvp.md");

test("Basic Final Cut editing MVP has an executable design contract", async () => {
  const contract = await readFile(contractPath, "utf8");

  assert.equal(BASIC_MVP_MEDIA.video.sourceDigest, `sha256:${createHash("sha256").update(BASIC_MVP_FIXTURE_BYTES.video).digest("hex")}`);
  assert.equal(BASIC_MVP_MEDIA.music.sourceDigest, `sha256:${createHash("sha256").update(BASIC_MVP_FIXTURE_BYTES.music).digest("hex")}`);

  assert.match(contract, /^# Basic Final Cut Editing MVP/m);
  for (const stage of [
    "Understand the active project",
    "Import local media",
    "Make a basic edit",
    "Add music and a title",
    "Export the result",
    "Verify the output",
  ]) {
    assert.match(contract, new RegExp(`## .*${stage}`));
  }

  for (const tool of [
    "connection.status",
    "editor.inspect",
    "project.inspect",
    "context.inspect",
    "media.import",
    "media.inspect",
    "artifact.edit",
    "artifact.publish",
    "editor.timeline.edit",
    "timeline.media.add",
    "timeline.title.add",
    "editor.timeline.edit.preview",
    "editor.timeline.edit.execute",
    "editor.assets",
    "timeline.export",
    "edit.diff",
    "edit.verify",
    "edit.undo",
  ]) {
    assert.match(contract, new RegExp("`" + tool + "`"));
  }

  assert.match(contract, /base revision/i);
  assert.match(contract, /CAPABILITY_UNAVAILABLE/);
  assert.match(contract, /TARGET_MISMATCH/);
  assert.match(contract, /deterministic fixture/i);
  assert.match(contract, /live Final Cut/i);
  assert.match(contract, /success metrics/i);
  assert.match(contract, /100%/);
  assert.match(contract, /rollback/i);
  assert.match(contract, /ordered operation list/i);
  assert.match(contract, /targetLane/);
  assert.match(contract, /verification\.assertions/);
  assert.match(contract, /expected versus observed/i);
  assert.match(contract, /status.*unavailable/i);
  assert.match(contract, /audio stream.*audible/i);
  assert.match(contract, /source identity/i);
  assert.match(contract, /semantic export/i);
});

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function jsonFrom(result: unknown): any {
  const text = textFrom(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MCP tool failed: ${text}`);
  }
}

test("Basic Final Cut editing MVP executes as one deterministic MCP workflow", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-basic-mvp-"));
  const outputPath = join(directory, "basic-mvp.mp4");
  const exporter = new FinalCutVideoExporter({
    enabled: true,
    executor: async (script) => {
      const match = script.match(/set value of first text field of front window to "([^"]+)"/);
      assert.ok(match?.[1]);
      await writeFile(match[1], "deterministic basic mvp export");
      return "started";
    },
    probe: async () => ({
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true,
    }),
    sleep: async () => undefined,
  });
  const adapter = new InMemoryEditorAdapter(BASIC_EDITING_MVP_FIXTURE);
  const runtime = new AgentVideoRuntime(adapter);
  const server = createMcpServer(runtime, { videoExporter: exporter });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "basic-editing-mvp-test", version: "0.1.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const connection = jsonFrom(await client.callTool({ name: "connection.status", arguments: {} }));
    assert.equal(connection.state, "ready");
    const editor = jsonFrom(await client.callTool({ name: "editor.inspect", arguments: {} }));
    assert.equal(editor.capabilities.editor.compositeTransactions, true);
    assert.equal(editor.capabilities.editor.mediaImport, true);
    assert.equal(editor.capabilities.editor.titlePlacement, true);

    const before = jsonFrom(await client.callTool({ name: "project.inspect", arguments: {} }));
    const beforeDigest = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    const assets = jsonFrom(await client.callTool({
      name: "editor.assets",
      arguments: { kind: "title", query: BASIC_MVP_TITLE_ASSET.name },
    }));
    assert.deepEqual(assets.map((asset: { id: string }) => asset.id), [BASIC_MVP_TITLE_ASSET.id]);

    const operations = [
      { type: "media.import", ...BASIC_MVP_MEDIA.video },
      { type: "timeline.media.add", occurrenceId: "fixture-video-occurrence", mediaId: BASIC_MVP_MEDIA.video.mediaId, role: "video", start: 0, duration: 5, targetLane: "primary" },
      { type: "trim-clip", clipId: "fixture-video-occurrence", duration: 4 },
      { type: "media.import", ...BASIC_MVP_MEDIA.music },
      { type: "timeline.media.add", occurrenceId: "fixture-music-occurrence", mediaId: BASIC_MVP_MEDIA.music.mediaId, role: "music", start: 0, duration: 4, targetLane: 1 },
      { type: "timeline.title.add", occurrenceId: "fixture-title-occurrence", assetId: BASIC_MVP_TITLE_ASSET.id, text: "Framekit MVP", start: 1, duration: 2, targetLane: 2 },
    ];
    const preview = jsonFrom(await client.callTool({
      name: "editor.timeline.edit.preview",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        operations,
      },
    }));
    assert.equal(preview.baseRevision.id, before.revision.id);
    assert.equal(preview.expectedDiff.added.length >= 3, true);
    const afterPreview = jsonFrom(await client.callTool({ name: "project.inspect", arguments: {} }));
    assert.equal(afterPreview.revision.id, before.revision.id);
    assert.equal(createHash("sha256").update(JSON.stringify(afterPreview)).digest("hex"), beforeDigest);

    const transaction = jsonFrom(await client.callTool({
      name: "editor.timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    }));
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.applied.length, operations.length);
    assert.equal(transaction.after.media.length, 2);
    assert.deepEqual(
      transaction.after.timeline.clips.map((clip: { id: string }) => clip.id),
      ["fixture-video-occurrence", "fixture-music-occurrence", "fixture-title-occurrence"],
    );
    assert.equal(transaction.after.timeline.clips[0].duration, 4);
    assert.equal(transaction.after.timeline.storyElements.find((element: { kind: string }) => element.kind === "title").text, "Framekit MVP");

    const diff = jsonFrom(await client.callTool({ name: "edit.diff", arguments: { transactionId: transaction.id } }));
    assert.equal(diff.added.some((item: { itemId: string }) => item.itemId === "fixture-title-occurrence"), true);
    const verification = jsonFrom(await client.callTool({ name: "edit.verify", arguments: { transactionId: transaction.id } }));
    assert.equal(verification.passed, true);

    const exported = jsonFrom(await client.callTool({
      name: "timeline.export",
      arguments: {
        outputPath,
        preset: "master",
        transactionId: transaction.id,
        expected: { durationSeconds: 4, hasAudio: true },
      },
    }));
    assert.equal(exported.verified, true);
    assert.equal(exported.metadata.hasAudio, true);
    assert.equal(exported.metadata.outputPath, outputPath);
    const output = await readFile(outputPath);
    assert.equal(output.toString("utf8"), "deterministic basic mvp export");
    assert.equal(exported.metadata.format, "mp4");
    assert.equal(exported.metadata.outputDigest, `sha256:${createHash("sha256").update(output).digest("hex")}`);
    assert.deepEqual(exported.manifest, {
      schemaVersion: 1,
      transactionId: transaction.id,
      sourceRevision: transaction.after.revision,
      project: { id: before.projectId, name: before.projectName },
      sequence: { id: before.timeline.id, name: before.timeline.name },
      timelineDurationSeconds: 4,
      media: [
        { mediaId: BASIC_MVP_MEDIA.video.mediaId, sourceDigest: BASIC_MVP_MEDIA.video.sourceDigest },
        { mediaId: BASIC_MVP_MEDIA.music.mediaId, sourceDigest: BASIC_MVP_MEDIA.music.sourceDigest },
      ],
      output: { format: "mp4", digest: exported.metadata.outputDigest },
    });
    assert.match(BASIC_MVP_MEDIA.video.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(BASIC_MVP_MEDIA.music.sourceDigest, /^sha256:[a-f0-9]{64}$/);

    const undone = jsonFrom(await client.callTool({ name: "edit.undo", arguments: { transactionId: transaction.id } }));
    assert.equal(undone.timeline.clips.length, 0);
    assert.equal(undone.media.length, 0);
    assert.equal(undone.timeline.storyElements.length, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Basic Final Cut editing MVP rejects stale and unavailable workflows before mutation", async () => {
  const staleAdapter = new InMemoryEditorAdapter(BASIC_EDITING_MVP_FIXTURE);
  const staleRuntime = new AgentVideoRuntime(staleAdapter);
  const staleBefore = await staleRuntime.inspectProject();
  const importOperation = {
    type: "media.import" as const,
    ...BASIC_MVP_MEDIA.video,
  };
  const stalePreview = await staleRuntime.previewEdit({
    baseRevision: staleBefore.revision,
    operations: [importOperation],
  });
  await staleAdapter.apply({
    type: "add-marker",
    timelineId: staleBefore.timeline.id,
    marker: { id: "outside-workflow", start: 0, duration: 0, name: "Outside workflow" },
  }, staleBefore.revision);
  await assert.rejects(staleRuntime.executeEdit(stalePreview.previewToken), /STALE_CONTEXT/);
  const staleAfter = await staleRuntime.inspectProject();
  assert.equal(staleAfter.media.length, 0);
  assert.equal(staleAfter.timeline.markers.length, 1);

  const unavailableAdapter = new InMemoryEditorAdapter(BASIC_EDITING_MVP_FIXTURE);
  const availableCapabilities = await unavailableAdapter.getCapabilities();
  unavailableAdapter.getCapabilities = async () => ({
    ...availableCapabilities,
    editor: { ...availableCapabilities.editor, mediaImport: false },
  });
  const unavailableRuntime = new AgentVideoRuntime(unavailableAdapter);
  const unavailableBefore = await unavailableRuntime.inspectProject();
  await assert.rejects(
    unavailableRuntime.previewEdit({ baseRevision: unavailableBefore.revision, operations: [importOperation] }),
    /CAPABILITY_UNAVAILABLE: media import/,
  );
  const unavailableAfter = await unavailableRuntime.inspectProject();
  assert.equal(canonicalSnapshotDigest(unavailableAfter), canonicalSnapshotDigest(unavailableBefore));
});

test("Basic Final Cut editing MVP rolls back a failed verification to the original digest", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(BASIC_EDITING_MVP_FIXTURE));
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{ type: "media.import", ...BASIC_MVP_MEDIA.video }],
    verification: {
      assertions: [{ type: "audio-audibility", mediaId: BASIC_MVP_MEDIA.video.mediaId }],
    },
  });
  const transaction = await runtime.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.passed, false);
  const after = await runtime.inspectProject();
  assert.equal(canonicalSnapshotDigest(after), canonicalSnapshotDigest(before));
  assert.equal(after.media.length, 0);
  assert.equal(after.timeline.clips.length, 0);
});
