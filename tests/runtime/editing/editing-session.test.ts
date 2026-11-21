import assert from "node:assert/strict";
import test from "node:test";
import {
  EditingSession,
  createTimelineIrFromProjectSnapshot,
  timelineIrDigest,
  type TimelineIr,
} from "@framekit/runtime";

/** Recursively reverses object-property insertion order while preserving values. */
function reverseObjectKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => reverseObjectKeyOrder(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
    ) as T;
  }
  return value;
}

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

test("title font identity persists and rejects incomplete assets", () => {
  const base = baseTimeline();
  const font = { family: "Noto Sans CJK JP", style: "Regular", postscriptName: "NotoSansCJKjp-Regular", digest: "a".repeat(64) };
  base.sequence.titles = [{ id: "title", text: "A日", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, lane: 1, font } as any];
  const restored = EditingSession.fromJSON(EditingSession.create({ base }).serialize()).desired();
  assert.deepEqual(restored.sequence.titles?.[0]?.font, font);
  const changed = structuredClone(base);
  changed.sequence.titles![0]!.font!.digest = "b".repeat(64);
  assert.notEqual(timelineIrDigest(base), timelineIrDigest(changed));
  for (const invalid of [null, { ...font, family: " " }, { ...font, digest: "bad" }, { ...font, extra: true }]) {
    const candidate = structuredClone(base);
    candidate.sequence.titles![0]!.font = invalid as typeof font;
    assert.throws(() => EditingSession.create({ base: candidate }), /TIMELINE_IR_INVALID:.*font/i);
  }
});

test("editing sessions retain native audio subroles across serialization", () => {
  const base = baseTimeline();
  base.sequence.occurrences[0]!.role = "audio";
  base.sequence.occurrences[0]!.nativeAudioRole = "dialogue.dialogue-1";
  const session = EditingSession.create({ base });
  const restored = EditingSession.fromJSON(session.serialize());
  assert.equal(restored.desired().sequence.occurrences[0]?.nativeAudioRole, "dialogue.dialogue-1");
});

test("editing sessions reject invalid native audio subroles", () => {
  for (const nativeAudioRole of ["", "dialogue.", "dialogue.voice.extra", "custom.role"]) {
    const base = baseTimeline();
    base.sequence.occurrences[0]!.nativeAudioRole = nativeAudioRole;
    assert.throws(() => EditingSession.create({ base }), /TIMELINE_IR_INVALID:.*nativeAudioRole/);
  }
  const base = baseTimeline();
  base.sequence.occurrences[0]!.role = "music";
  base.sequence.occurrences[0]!.nativeAudioRole = "dialogue.dialogue-1";
  assert.throws(() => EditingSession.create({ base }), /TIMELINE_IR_INVALID:.*nativeAudioRole/);
});

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

/** Proves canonical encoding is independent of object-property insertion order. */
function assertCanonicalEncodingIsDeterministic(): void {
  const canonical = baseTimeline();
  const reordered = reverseObjectKeyOrder(canonical);

  const originalEncoding = EditingSession.create({ base: canonical }).serialize();
  const reorderedEncoding = EditingSession.create({ base: reordered }).serialize();

  assert.equal(reorderedEncoding, originalEncoding);
}

test("encodes equivalent canonical state deterministically regardless of object key order", assertCanonicalEncodingIsDeterministic);

/** Proves provider identities stay in explicit bindings beside logical IDs. */
function assertProviderBindingIsSeparateFromLogicalIdentity(): void {
  const serialized = JSON.parse(EditingSession.create({ base: baseTimeline() }).serialize()) as { base: TimelineIr };
  const resource = serialized.base.resources[0];

  assert.equal(resource?.id, "media-1");
  assert.deepEqual(resource?.binding, { provider: "final-cut", kind: "resource", identity: "asset-1" });
  assert.notEqual(resource?.id, resource?.binding?.identity);
}

test("keeps provider bindings separate from logical Timeline IR identity", assertProviderBindingIsSeparateFromLogicalIdentity);

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


test("canonical dissolve recovery rejects invalid provider readback", () => {
  const source = {
    projectId: "p", projectName: "P", revision: { id: "r", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" },
    timeline: { id: "s", name: "S", duration: 4, durationTime: { value: "4", timescale: "1" }, frameDuration: { value: "1", timescale: "30" },
      clips: [
        { id: "a", name: "A", mediaId: "m", start: 0, duration: 1.75, track: 0, startTime: { value: "0", timescale: "1" }, durationTime: { value: "53", timescale: "30" }, sourceStartTime: { value: "1", timescale: "1" } },
        { id: "b", name: "B", mediaId: "m", start: 1.75, duration: 2.25, track: 0, startTime: { value: "53", timescale: "30" }, durationTime: { value: "67", timescale: "30" }, sourceStartTime: { value: "113", timescale: "30" } },
      ],
      storyElements: [{ id: "t", kind: "transition", transitionKind: "cross-dissolve" as const, beforeClipId: "a", afterClipId: "b", start: 1.5, duration: 0.5, startTime: { value: "3", timescale: "2" }, durationTime: { value: "1", timescale: "2" } }], markers: [], captions: [],
    },
    media: [{ mediaId: "m", source: "/media/source.mov", mediaKind: "video" as const }],
  };
  const result = createTimelineIrFromProjectSnapshot(source);
  assert.deepEqual(result.sequence.occurrences[1]!.sourceStartTime, { value: "4", timescale: "1" });
  assert.equal(result.sequence.transitions?.[0]?.afterOccurrenceId, "b");
  const fractional = structuredClone(source);
  fractional.timeline.frameDuration = { value: "1001", timescale: "30000" };
  fractional.timeline.clips[0]!.durationTime = { value: "53053", timescale: "30000" };
  fractional.timeline.clips[1]!.startTime = { value: "53053", timescale: "30000" };
  fractional.timeline.clips[1]!.durationTime = { value: "67067", timescale: "30000" };
  fractional.timeline.clips[1]!.sourceStartTime = { value: "83083", timescale: "30000" };
  fractional.timeline.storyElements[0]!.startTime = { value: "3003", timescale: "2000" };
  fractional.timeline.storyElements[0]!.durationTime = { value: "1001", timescale: "2000" };
  const recovered = createTimelineIrFromProjectSnapshot(fractional);
  assert.deepEqual(recovered.sequence.occurrences[1]!.startTime, { value: "1001", timescale: "500" });
  assert.deepEqual(recovered.sequence.occurrences[1]!.sourceStartTime, { value: "3003", timescale: "1000" });
  assert.deepEqual(recovered.sequence.occurrences[1]!.durationTime, { value: "1001", timescale: "500" });
  for (const mutation of ["negative-source", "audio-endpoint", "overlap-before", "missing-source"] as const) {
    const invalid = structuredClone(source);
    if (mutation === "negative-source") invalid.timeline.clips[1]!.sourceStartTime = { value: "-1", timescale: "1" };
    if (mutation === "audio-endpoint") Object.assign(invalid.timeline.clips[0]!, { role: "music" });
    if (mutation === "overlap-before") invalid.timeline.clips[0]!.startTime = { value: "7", timescale: "4" };
    if (mutation === "missing-source") delete (invalid.timeline.clips[1]! as { sourceStartTime?: unknown }).sourceStartTime;
    assert.throws(() => createTimelineIrFromProjectSnapshot(invalid), /TIMELINE_IR_.*transition/i, mutation);
  }
});
