import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function createMusicRuntime() {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-music",
    projectName: "Music Mixing Fixture",
    timelineId: "timeline-music",
    timelineName: "Main Edit",
    clips: [{
      id: "clip-dialogue",
      mediaId: "media-dialogue",
      name: "Dialogue",
      start: 0,
      duration: 8,
      track: 1,
    }],
    media: [{
      mediaId: "media-dialogue",
      source: "dialogue.wav",
      mediaKind: "audio",
      duration: 8,
      audio: { integratedLufs: -18, truePeakDb: -3, silenceMs: 0 },
    }],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter) };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("music workflow previews, mixes, verifies, and undoes an appended music bed", async () => {
  const { runtime } = createMusicRuntime();
  const before = await runtime.inspectProject();

  const preview = await runtime.previewMusic({
    baseRevision: before.revision,
    occurrenceId: "clip-music",
    import: {
      mediaId: "media-music",
      source: "/fixtures/music-bed.wav",
      duration: 6,
      sourceDigest: "sha256:music-bed",
    },
    placement: "append",
    duration: 6,
    targetLane: -1,
    gainDb: -14,
    fadeIn: 0.5,
    fadeOut: 1,
  });

  assert.deepEqual(await runtime.inspectProject(), before);
  assert.equal(preview.expectedDiff.added[0]?.itemId, "clip-music");
  assert.equal(preview.expectedDiff.mediaChanges[0]?.media.mediaId, "media-music");
  assert.equal(preview.operations.length, 4);

  const transaction = await runtime.executeEdit(preview.previewToken);
  const music = transaction.after.timeline.clips.find((clip) => clip.id === "clip-music");

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(music?.start, 8);
  assert.equal(music?.duration, 6);
  assert.equal(music?.track, -1);
  assert.equal(music?.gainDb, -14);
  assert.equal(music?.fadeIn, 0.5);
  assert.equal(music?.fadeOut, 1);
  assert.equal(transaction.verification?.checks.some((check) => check.name === "audio-state" && check.passed), true);

  const restored = await runtime.undo(transaction.id);
  assert.deepEqual(restored.timeline.clips, before.timeline.clips);
  assert.deepEqual(restored.media, before.media);
});

test("MCP exposes guarded music preview, execute, verification, and undo", async () => {
  const { runtime } = createMusicRuntime();
  const server = createMcpServer(runtime);
  const client = new Client({ name: "music-mixing-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "music.add"));
    assert.ok(tools.tools.some((tool) => tool.name === "music.add.execute"));

    const before = await runtime.inspectProject();
    const preview = JSON.parse(textFrom(await client.callTool({
      name: "music.add",
      arguments: {
        baseRevision: before.revision,
        occurrenceId: "clip-music-mcp",
        import: {
          mediaId: "media-music-mcp",
          source: "/fixtures/music-mcp.wav",
          duration: 4,
          sourceDigest: "sha256:music-mcp",
        },
        placement: "append",
        duration: 4,
        targetLane: -1,
        gainDb: -12,
        fadeIn: 0.25,
        fadeOut: 0.5,
      },
    })));
    assert.match(preview.previewToken, /^preview-/);
    assert.deepEqual(await runtime.inspectProject(), before);

    const transaction = JSON.parse(textFrom(await client.callTool({
      name: "music.add.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.after.timeline.clips.at(-1).gainDb, -12);

    const undone = JSON.parse(textFrom(await client.callTool({
      name: "edit.undo",
      arguments: { transactionId: transaction.id },
    })));
    assert.deepEqual(undone.timeline.clips, before.timeline.clips);
    assert.deepEqual(undone.media, before.media);

    const ducked = await client.callTool({
      name: "music.add",
      arguments: {
        baseRevision: before.revision,
        occurrenceId: "clip-music-ducked-mcp",
        mediaId: "media-dialogue",
        placement: "insert",
        start: 0,
        duration: 3,
        targetLane: -1,
        ducking: { enabled: true, dialogueClipIds: ["clip-dialogue"], reductionDb: 6 },
      },
    });
    assert.equal(ducked.isError, true);
    assert.match(textFrom(ducked), /CAPABILITY_UNAVAILABLE: dialogue ducking/);
    assert.deepEqual(await runtime.inspectProject(), undone);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP composite preview accepts explicit audio fades", async () => {
  const { runtime } = createMusicRuntime();
  const server = createMcpServer(runtime);
  const client = new Client({ name: "music-fade-schema-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const before = await runtime.inspectProject();
    const previewResult = await client.callTool({
      name: "timeline.edit.preview",
      arguments: {
        baseRevision: before.revision,
        operations: [{
          type: "timeline.audio.fades",
          clipId: "clip-dialogue",
          fadeIn: 0.5,
          fadeOut: 1,
        }],
      },
    });
    assert.equal(previewResult.isError, undefined);
    const preview = JSON.parse(textFrom(previewResult));
    assert.equal(preview.expectedDiff.modified[0]?.after.fadeIn, 0.5);
    assert.equal(preview.expectedDiff.modified[0]?.after.fadeOut, 1);

    const transaction = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(transaction.status, "VERIFIED");
  } finally {
    await client.close();
    await server.close();
  }
});

test("music workflow inserts an existing searched media item at an explicit position", async () => {
  const { runtime } = createMusicRuntime();
  const before = await runtime.inspectProject();
  const preview = await runtime.previewMusic({
    baseRevision: before.revision,
    occurrenceId: "clip-music-insert",
    mediaId: "media-dialogue",
    placement: "insert",
    start: 2,
    duration: 3,
    targetLane: -2,
    gainDb: -10,
  });

  assert.equal(preview.expectedDiff.added[0]?.after?.start, 2);
  assert.equal(preview.expectedDiff.added[0]?.after?.duration, 3);
  const transaction = await runtime.executeEdit(preview.previewToken);
  const inserted = transaction.after.timeline.clips.find((clip) => clip.id === "clip-music-insert");
  assert.equal(transaction.status, "VERIFIED");
  assert.deepEqual(
    { start: inserted?.start, duration: inserted?.duration, track: inserted?.track, gainDb: inserted?.gainDb },
    { start: 2, duration: 3, track: -2, gainDb: -10 },
  );
});

test("music workflow reports dialogue ducking as an explicit unavailable capability", async () => {
  const { runtime } = createMusicRuntime();
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewMusic({
      baseRevision: before.revision,
      occurrenceId: "clip-music-ducked",
      mediaId: "media-dialogue",
      placement: "insert",
      start: 0,
      duration: 3,
      targetLane: -1,
      ducking: { enabled: true, dialogueClipIds: ["clip-dialogue"], reductionDb: 6 },
    }),
    /CAPABILITY_UNAVAILABLE: dialogue ducking/,
  );
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("music workflow rejects a duration longer than the known source", async () => {
  const { runtime } = createMusicRuntime();
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.previewMusic({
      baseRevision: before.revision,
      occurrenceId: "clip-music-too-long",
      mediaId: "media-dialogue",
      placement: "insert",
      start: 0,
      duration: 9,
      targetLane: -1,
    }),
    /INVALID_OPERATION: music duration exceeds the source duration/,
  );
  assert.deepEqual(await runtime.inspectProject(), before);
});
