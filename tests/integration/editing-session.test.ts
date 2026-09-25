import assert from "node:assert/strict";
import test from "node:test";
import {
  EditingSession,
  createTimelineIrFromProjectSnapshot,
  registerLocalMediaResource,
  type TimelineIr,
} from "@framekit/runtime";

function baseTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [{
      id: "media-1",
      name: "opening.mov",
      mediaKind: "video",
      source: "/media/opening.mov",
      binding: { provider: "final-cut", kind: "resource", identity: "asset-1" },
    }],
    revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-14T00:00:00.000Z" },
  };
}

test("serializes and loads a provider-neutral session without losing rational identity", () => {
  const session = EditingSession.create({
    base: baseTimeline(),
    provider: { id: "final-cut", version: "10.7.1" },
    clock: () => "2026-09-14T00:01:00.000Z",
  });

  const restored = EditingSession.fromJSON(session.serialize());

  assert.deepEqual(restored.document(), session.document());
  assert.equal(restored.desired().sequence.occurrences[0]?.durationTime.value, "90");
  assert.equal(restored.desired().sequence.occurrences[0]?.durationTime.timescale, "30");
  assert.deepEqual(restored.desired().resources[0]?.binding, {
    provider: "final-cut",
    kind: "resource",
    identity: "asset-1",
  });
});

test("registers one explicitly selected local source with bound identity metadata", () => {
  const registered = registerLocalMediaResource(baseTimeline(), {
    mediaId: "media-background",
    name: "background.mov",
    source: "/tmp/background.mov",
    sourceDigest: "sha256:background",
    mediaKind: "video",
    duration: 12.5,
  });

  assert.deepEqual(registered.resources.at(-1), {
    id: "media-background",
    name: "background.mov",
    mediaKind: "video",
    source: "/tmp/background.mov",
    sourceDigest: "sha256:background",
    duration: 12.5,
    binding: {
      provider: "framekit-local-media",
      kind: "resource",
      identity: "media-background@sha256:background",
    },
  });
  assert.doesNotThrow(() => EditingSession.create({ base: registered }));
});

test("rejects ambiguous local source registration", () => {
  assert.throws(
    () => registerLocalMediaResource(baseTimeline(), {
      mediaId: "media-background",
      name: "background.mov",
      source: "background.mov",
      sourceDigest: "sha256:background",
      mediaKind: "video",
      duration: 12.5,
    }),
    /LOCAL_MEDIA_SOURCE_INVALID: source must be an absolute path or file URL/,
  );
});

test("adds a registered local source to the desired background session", () => {
  const session = EditingSession.create({ base: baseTimeline() });

  const resource = session.registerLocalMedia({
    mediaId: "media-background",
    name: "background.mov",
    source: "/tmp/background.mov",
    sourceDigest: "sha256:background",
    mediaKind: "video",
    duration: 12.5,
  });

  assert.equal(resource.id, "media-background");
  assert.equal(session.base().resources.some(({ id }) => id === "media-background"), false);
  assert.equal(session.desired().resources.some(({ id }) => id === "media-background"), true);
  assert.equal(session.state(), "dirty");
});

test("previews and applies deterministic edits while Final Cut is unavailable", () => {
  const session = EditingSession.create({ base: baseTimeline(), clock: () => "2026-09-14T00:01:00.000Z" });
  const operations = [
    { type: "rename-occurrence" as const, occurrenceId: "occurrence-1", name: "Opening revised" },
    { type: "trim-occurrence" as const, occurrenceId: "occurrence-1", durationTime: { value: "120", timescale: "30" } },
    { type: "add-marker" as const, marker: {
      id: "marker-1",
      name: "Review",
      startTime: { value: "60", timescale: "30" },
      durationTime: { value: "15", timescale: "30" },
    } },
  ];

  const preview = session.preview(operations);

  assert.equal(session.state(), "clean");
  assert.equal(session.desired().sequence.occurrences[0]?.name, "Opening");
  assert.equal(preview.after.sequence.occurrences[0]?.name, "Opening revised");
  assert.deepEqual(preview.after.sequence.occurrences[0]?.durationTime, { value: "4", timescale: "1" });
  assert.deepEqual(preview.after.sequence.markers[0]?.startTime, { value: "2", timescale: "1" });
  assert.deepEqual(preview.after.sequence.markers[0]?.durationTime, { value: "1", timescale: "2" });

  const applied = session.apply(operations);

  assert.equal(applied.state, "dirty");
  assert.equal(session.state(), "dirty");
  assert.equal(session.desired().revision.sequence, 5);
  assert.equal(session.desired().sequence.occurrences[0]?.name, "Opening revised");
});

test("rejects stale desired revisions before changing the session", () => {
  const session = EditingSession.create({ base: baseTimeline() });

  assert.throws(
    () => session.apply(
      [{ type: "set-gain" as const, occurrenceId: "occurrence-1", gainDb: -3 }],
      { id: "other", sequence: 99, timestamp: "2026-09-14T00:00:00.000Z" },
    ),
    /STALE_CONTEXT/,
  );
  assert.equal(session.state(), "clean");
  assert.equal(session.desired().sequence.occurrences[0]?.gainDb, undefined);
});

test("blocks stale session plans without changing BASE or OURS", () => {
  const session = EditingSession.create({ base: baseTimeline() });
  session.apply([{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Agent edit" }]);
  const before = session.document();

  assert.equal(session.observeProviderRevision({
    id: "provider-revision-2",
    sequence: 5,
    timestamp: "2026-09-14T00:02:00.000Z",
  }), "changed");
  assert.equal(session.state(), "possibly_stale");
  assert.deepEqual(session.base(), before.base);
  assert.deepEqual(session.desired(), before.desired);

  const operation = [{ type: "set-gain" as const, occurrenceId: "occurrence-1", gainDb: -3 }];
  assert.throws(() => session.preview(operation), /RECONCILIATION_REQUIRED/);
  assert.throws(() => session.apply(operation), /RECONCILIATION_REQUIRED/);
  assert.deepEqual(session.desired(), before.desired);
});

test("can construct an IR from a canonical snapshot without leaking editor types", () => {
  const ir = createTimelineIrFromProjectSnapshot({
    projectId: "project-1",
    projectName: "Project",
    timeline: {
      id: "sequence-1",
      name: "Main",
      duration: 10,
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      clips: [{
        id: "occurrence-1",
        mediaId: "media-1",
        name: "Opening",
        start: 0,
        duration: 3,
        track: 0,
        role: "video",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "media-1", source: "/media/opening.mov", mediaKind: "video", duration: 3 }],
    revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-14T00:00:00.000Z" },
  });

  assert.equal(ir.schemaVersion, 1);
  assert.equal(ir.sequence.occurrences[0]?.id, "occurrence-1");
  assert.equal(ir.sequence.occurrences[0]?.startTime.value, "0");
  assert.equal(ir.resources[0]?.source, "/media/opening.mov");
  assert.equal("clips" in ir.sequence, false);
});
