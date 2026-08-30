import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProjectSnapshot } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

import { AgentVideoRuntime, planRoughCut } from "@framekit/runtime";
import type { RoughCutPlanRequest, WorkflowOperation } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function emptyProject(): ProjectSnapshot {
  return {
    projectId: "project-rough-cut",
    projectName: "Rough Cut Fixture",
    timeline: {
      id: "timeline-rough-cut",
      name: "Main Cut",
      duration: 3,
      durationTime: { value: "3", timescale: "1" },
      clips: [{
        id: "existing-clip",
        name: "Existing",
        start: 0,
        duration: 3,
        track: 0,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "3", timescale: "1" },
      }],
      storyElements: [{
        id: "existing-clip",
        kind: "asset-clip",
        start: 0,
        duration: 3,
        lane: 0,
      }],
      markers: [],
      captions: [],
    },
    media: [{
      mediaId: "existing-media",
      source: "/fixtures/existing.mov",
      mediaKind: "video",
      duration: 3,
    }],
    revision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function request(baseRevision: ProjectSnapshot["revision"]): RoughCutPlanRequest {
  return {
    baseRevision,
    imports: [
      {
        type: "media.import",
        mediaId: "media-a",
        source: "/fixtures/a.mov",
        mediaKind: "video",
        duration: 6,
        sourceDigest: "sha256:a",
      },
      {
        type: "media.import",
        mediaId: "media-b",
        source: "/fixtures/b.mov",
        mediaKind: "video",
        duration: 4,
        sourceDigest: "sha256:b",
      },
    ],
    shots: [
      { occurrenceId: "shot-a", mediaId: "media-a", duration: 5 },
      { occurrenceId: "shot-b", mediaId: "media-b" },
    ],
  };
}

function runtime() {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-rough-cut",
    projectName: "Rough Cut Fixture",
    timelineId: "timeline-rough-cut",
    timelineName: "Main Cut",
    clips: [{ id: "existing-clip", name: "Existing", start: 0, duration: 3, track: 0 }],
    media: [{ mediaId: "existing-media", source: "/fixtures/existing.mov", mediaKind: "video", duration: 3 }],
  }));
}

test("rough-cut planner emits deterministic imports and sequential primary shots", () => {
  const before = emptyProject();
  const first = planRoughCut(before, request(before.revision));
  const second = planRoughCut(before, request(before.revision));

  assert.deepEqual(first, second);
  assert.deepEqual(first.operations, [
    {
      type: "media.import",
      mediaId: "media-a",
      source: "/fixtures/a.mov",
      mediaKind: "video",
      duration: 6,
      sourceDigest: "sha256:a",
    },
    {
      type: "media.import",
      mediaId: "media-b",
      source: "/fixtures/b.mov",
      mediaKind: "video",
      duration: 4,
      sourceDigest: "sha256:b",
    },
    {
      type: "timeline.media.add",
      occurrenceId: "shot-a",
      mediaId: "media-a",
      role: "video",
      start: 3,
      duration: 5,
      targetLane: "primary",
    },
    {
      type: "timeline.media.add",
      occurrenceId: "shot-b",
      mediaId: "media-b",
      role: "video",
      start: 8,
      duration: 4,
      targetLane: "primary",
    },
  ]);
  assert.equal(first.projectId, "project-rough-cut");
  assert.equal(first.timelineId, "timeline-rough-cut");
  assert.equal(first.duration, 12);
});

test("runtime rough-cut planning is read-only and binds the base revision", async () => {
  const active = runtime();
  const before = await active.inspectProject();

  const plan = await active.planRoughCut(request(before.revision));

  assert.equal(plan.baseRevision.id, before.revision.id);
  assert.deepEqual(await active.inspectProject(), before);
});

test("rough-cut planner rejects missing, non-video, and overlong shots", () => {
  const before = emptyProject();

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    shots: [{ occurrenceId: "missing", mediaId: "not-found" }],
  }), /MEDIA_NOT_FOUND/);

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    imports: [{
      type: "media.import",
      mediaId: "audio-only",
      source: "/fixtures/audio.wav",
      mediaKind: "audio",
      duration: 5,
      sourceDigest: "sha256:audio",
    }],
    shots: [{ occurrenceId: "audio-shot", mediaId: "audio-only" }],
  }), /ROUGH_CUT_VIDEO_REQUIRED/);

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    imports: [{
      type: "media.import",
      mediaId: "short",
      source: "/fixtures/short.mov",
      mediaKind: "video",
      duration: 2,
      sourceDigest: "sha256:short",
    }],
    shots: [{ occurrenceId: "too-long", mediaId: "short", duration: 3 }],
  }), /ROUGH_CUT_DURATION_EXCEEDS_SOURCE/);

  assert.throws(() => planRoughCut(before, {
    baseRevision: before.revision,
    imports: [{
      type: "media.import",
      mediaId: " ",
      source: "/fixtures/blank-id.mov",
      mediaKind: "video",
      duration: 2,
      sourceDigest: "sha256:blank-id",
    }],
    shots: [{ occurrenceId: "existing-shot", mediaId: "existing-media" }],
  }), /INVALID_OPERATION: imported media requires/);
});

function constructionRuntime(transitionKinds = ["asset-clip"]) {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-construction",
    projectName: "Construction Fixture",
    timelineId: "timeline-construction",
    timelineName: "Main Cut",
    clips: [
      { id: "base-a", mediaId: "base-a-media", name: "Base A", start: 0, duration: 4, track: 0 },
      { id: "base-b", mediaId: "base-b-media", name: "Base B", start: 4, duration: 4, track: 0 },
      { id: "remove-me", mediaId: "remove-media", name: "Remove Me", start: 8, duration: 1, track: 0 },
    ],
    media: [
      { mediaId: "base-a-media", source: "/fixtures/base-a.mov", mediaKind: "video", duration: 4 },
      { mediaId: "base-b-media", source: "/fixtures/base-b.mov", mediaKind: "video", duration: 4 },
      { mediaId: "remove-media", source: "/fixtures/remove.mov", mediaKind: "video", duration: 1 },
    ],
    assets: [{
      id: "transition-dissolve",
      kind: "transition",
      name: "Cross Dissolve",
      vendor: "Framekit Fixture",
      metadata: {},
      compatibility: { timelineKinds: transitionKinds },
    }],
  });
  return { adapter, runtime: new AgentVideoRuntime(adapter) };
}

function constructionOperations(): WorkflowOperation[] {
  return [{
    type: "media.import",
    mediaId: "replacement-media",
    source: "/fixtures/replacement.mov",
    mediaKind: "video",
    duration: 3,
    sourceDigest: "sha256:replacement",
  }, {
    type: "media.import",
    mediaId: "voice-media",
    source: "/fixtures/voice.wav",
    mediaKind: "audio",
    duration: 2,
    sourceDigest: "sha256:voice",
  }, {
    type: "timeline.transition.add",
    transitionId: "transition-base",
    assetId: "transition-dissolve",
    beforeClipId: "base-a",
    afterClipId: "base-b",
    duration: 1,
  }, {
    type: "timeline.media.move",
    occurrenceId: "base-b",
    start: 5,
    targetLane: "primary",
  }, {
    type: "timeline.media.replace",
    occurrenceId: "base-a",
    mediaId: "replacement-media",
    duration: 3,
  }, {
    type: "timeline.audio.attach",
    occurrenceId: "voice-occurrence",
    targetClipId: "base-a",
    mediaId: "voice-media",
    startOffset: 0.5,
    duration: 2,
  }, {
    type: "timeline.audio.mix",
    clipId: "voice-occurrence",
    gainDb: -12,
    fadeIn: 0.25,
    fadeOut: 0.25,
  }, {
    type: "timeline.media.remove",
    occurrenceId: "remove-me",
  }] as unknown as WorkflowOperation[];
}

test("fixture construction supports move, replace, remove, transitions, and attached audio mixing", async () => {
  const { runtime: active } = constructionRuntime();
  const before = await active.inspectProject();
  const preview = await active.previewEdit({ baseRevision: before.revision, operations: constructionOperations() });

  assert.deepEqual(await active.inspectProject(), before);
  assert.equal(preview.expectedDiff.mediaChanges.filter((change) => change.type === "MEDIA_ADDED").length, 2);
  assert.equal(preview.expectedDiff.storyElementChanges.some((change) => change.element.kind === "transition"), true);

  const transaction = await active.executeEdit(preview.previewToken);
  const after = transaction.after;
  const moved = after.timeline.clips.find((clip) => clip.id === "base-b");
  const replaced = after.timeline.clips.find((clip) => clip.id === "base-a");
  const audio = after.timeline.clips.find((clip) => clip.id === "voice-occurrence");

  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "construction-state")?.passed, true);
  assert.equal(moved?.start, 5);
  assert.equal(replaced?.mediaId, "replacement-media");
  assert.equal(replaced?.duration, 3);
  assert.equal(after.timeline.clips.some((clip) => clip.id === "remove-me"), false);
  assert.equal(audio?.attachedTo, "base-a");
  assert.equal(audio?.gainDb, -12);
  assert.equal(audio?.fadeIn, 0.25);
  assert.equal(audio?.fadeOut, 0.25);
  assert.equal(after.timeline.storyElements.some((element) => element.id === "transition-base" && element.kind === "transition"), true);
  assert.equal(transaction.diff.modified.some((change) => change.itemId === "base-b"), true);
  assert.equal(transaction.diff.modified.some((change) => change.itemId === "base-a"), true);

  const undone = await active.undo(transaction.id);
  assert.deepEqual({ clips: undone.timeline.clips, media: undone.media }, { clips: before.timeline.clips, media: before.media });
});

test("unsupported construction capabilities fail before preview mutation", async () => {
  const { adapter, runtime: active } = constructionRuntime();
  const before = await active.inspectProject();
  const originalCapabilities = adapter.getCapabilities.bind(adapter);
  adapter.getCapabilities = async () => ({
    ...await originalCapabilities(),
    editor: {
      ...(await originalCapabilities()).editor,
      clipMove: false,
    } as never,
  });

  await assert.rejects(active.previewEdit({ baseRevision: before.revision, operations: constructionOperations() }), /CAPABILITY_UNAVAILABLE/);
  assert.deepEqual(await active.inspectProject(), before);
});

test("incompatible transition assets fail before preview mutation", async () => {
  const { runtime: active } = constructionRuntime(["title"]);
  const before = await active.inspectProject();

  await assert.rejects(active.previewEdit({
    baseRevision: before.revision,
    operations: [constructionOperations()[2]!],
  }), /TRANSITION_ASSET_INCOMPATIBLE/);
  assert.deepEqual(await active.inspectProject(), before);
});

test("media replacement preserves the existing media kind", async () => {
  const { runtime: active } = constructionRuntime();
  const before = await active.inspectProject();

  await assert.rejects(active.previewEdit({
    baseRevision: before.revision,
    operations: [{
      type: "media.import",
      mediaId: "audio-replacement",
      source: "/fixtures/replacement.wav",
      mediaKind: "audio",
      duration: 4,
      sourceDigest: "sha256:audio-replacement",
    }, {
      type: "timeline.media.replace",
      occurrenceId: "base-a",
      mediaId: "audio-replacement",
    }],
  }), /MEDIA_KIND_MISMATCH/);
  assert.deepEqual(await active.inspectProject(), before);
});

test("media move without a lane preserves the primary storyline", async () => {
  const { runtime: active } = constructionRuntime();
  const before = await active.inspectProject();
  const preview = await active.previewEdit({
    baseRevision: before.revision,
    operations: [{ type: "timeline.media.move", occurrenceId: "base-a", start: 1 }],
  });

  assert.deepEqual(await active.inspectProject(), before);
  const transaction = await active.executeEdit(preview.previewToken);
  const moved = transaction.after.timeline.clips.find((clip) => clip.id === "base-a");
  assert.equal(transaction.status, "VERIFIED");
  assert.equal(moved?.start, 1);
  assert.equal(moved?.track, 0);
});

test("construction verification keeps stable fields after a later move", async () => {
  const { adapter, runtime: active } = constructionRuntime();
  const originalApplyTransaction = adapter.applyTransaction.bind(adapter);
  adapter.applyTransaction = async (operations, expectedRevision) => {
    await originalApplyTransaction(operations, expectedRevision);
    const current = await adapter.read();
    await adapter.restore({
      ...current,
      timeline: {
        ...current.timeline,
        clips: current.timeline.clips.map((clip) => clip.id === "moving-clip"
          ? { ...clip, mediaId: "base-a-media" }
          : clip),
        storyElements: current.timeline.storyElements.map((element) => element.id === "moving-clip"
          ? { ...element, mediaId: "base-a-media" }
          : element),
      },
    }, current.revision);
  };

  const before = await active.inspectProject();
  const preview = await active.previewEdit({
    baseRevision: before.revision,
    operations: [{
      type: "media.import",
      mediaId: "moving-media",
      source: "/fixtures/moving.mov",
      mediaKind: "video",
      duration: 2,
      sourceDigest: "sha256:moving",
    }, {
      type: "timeline.media.add",
      occurrenceId: "moving-clip",
      mediaId: "moving-media",
      role: "video",
      start: 9,
      duration: 2,
      targetLane: "primary",
    }, {
      type: "timeline.media.move",
      occurrenceId: "moving-clip",
      start: 10,
    }],
  });

  const transaction = await active.executeEdit(preview.previewToken);
  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(transaction.verification?.checks.find((check) => check.name === "construction-state")?.passed, false);
  assert.deepEqual(await active.inspectProject(), before);
});

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

test("MCP exposes read-only rough-cut planning and a guarded preview", async () => {
  const active = runtime();
  const server = createMcpServer(active);
  const client = new Client({ name: "rough-cut-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "rough-cut.plan"));
    assert.ok(tools.tools.some((tool) => tool.name === "rough-cut.preview"));

    const before = await active.inspectProject();
    const argumentsValue = request(before.revision);
    const planned = JSON.parse(textFrom(await client.callTool({
      name: "rough-cut.plan",
      arguments: { ...argumentsValue },
    })));
    assert.equal(planned.operations.length, 4);
    assert.equal(planned.duration, 12);
    assert.deepEqual(await active.inspectProject(), before);

    const preview = JSON.parse(textFrom(await client.callTool({
      name: "rough-cut.preview",
      arguments: { ...argumentsValue },
    })));
    assert.match(preview.previewToken, /^preview-/);
    assert.deepEqual(preview.plan.operations, planned.operations);
    assert.deepEqual(await active.inspectProject(), before);
  } finally {
    await client.close();
    await server.close();
  }
});

test("rough-cut construction contract documents lifecycle and backend boundaries", async () => {
  const contract = await readFile(resolve("docs/architecture/rough-cut-construction.md"), "utf8");
  const tools = await readFile(resolve("docs/mcp/tools.md"), "utf8");

  assert.match(contract, /^# Rough-Cut Project Construction/m);
  for (const operation of [
    "timeline.media.add",
    "timeline.media.move",
    "timeline.media.replace",
    "timeline.media.remove",
    "timeline.transition.add",
    "timeline.audio.attach",
    "timeline.audio.mix",
  ]) {
    assert.match(contract, new RegExp("`" + operation + "`"));
  }
  for (const stage of ["rough-cut.plan", "rough-cut.preview", "timeline.edit.execute", "edit.diff", "edit.verify", "edit.undo"]) {
    assert.match(contract, new RegExp("`" + stage + "`"));
  }
  assert.match(contract, /CAPABILITY_UNAVAILABLE/);
  assert.match(contract, /timeline\.publish\.new-project/);
  assert.match(contract, /does not replace the active project/i);
  assert.ok(tools.indexOf("`music.add` is the high-level") < tools.indexOf("## Rough-cut construction workflow"));
});
