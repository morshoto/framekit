import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import type { VerificationEngine } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

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

function workflowOperations() {
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
  assert.deepEqual(transaction.after.media.map((media) => media.mediaId), ["media-video", "media-music"]);
  assert.equal(transaction.diff.affectedRanges.length > 0, true);
  assert.equal(transaction.verification?.passed, true);

  const undone = await runtime.undo(transaction.id);
  assert.deepEqual(projectContent(undone), projectContent(before));
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
