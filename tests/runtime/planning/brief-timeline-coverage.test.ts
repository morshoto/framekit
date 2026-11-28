import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCreativeBrief, type CreativeBrief } from "../../../packages/runtime/src/planning/creative-brief.js";
import { inspectBriefTimelineCoverage } from "../../../packages/runtime/src/planning/brief-timeline-coverage.js";
import type { TimelineIr } from "../../../packages/runtime/src/timeline/editing-session.js";

const digest = "a".repeat(64);
const brief: CreativeBrief = {
  schemaVersion: 1, id: "interview", version: 1, purpose: { kind: "specified", value: "interview" },
  audience: { kind: "no-preference" }, durationSeconds: { min: 30, max: 60 }, aspectRatio: "16:9",
  theme: "natural", visualDirection: "natural", requiredContent: ["answer"], excludedContent: [],
  speechPolicy: { kind: "no-preference" }, musicPolicy: { kind: "no-preference" }, captionPolicy: { kind: "no-preference" },
  sourceCoverage: [{ requirement: "answer", sourceId: "source", sourceDigest: digest, start: 19.3, end: 42.58 }],
  inferences: [], reviewPrompts: [],
};
const t = (value: number, timescale = 100) => ({ value: String(value), timescale: String(timescale) });
const timeline = {
  schemaVersion: 1, project: { id: "p", name: "P" },
  sequence: { id: "s", name: "S", durationTime: t(3000), frameDuration: t(1, 30),
    occurrences: [
      { id: "a", name: "A", mediaId: "source", role: "video", track: 0, startTime: t(0), sourceStartTime: t(1930), durationTime: t(1000) },
      { id: "b", name: "B", mediaId: "source", role: "video", track: 0, startTime: t(1000), sourceStartTime: t(2930), durationTime: t(1328) },
    ], storyElements: [], markers: [], captions: [] },
  resources: [{ id: "source", name: "Source", mediaKind: "video", source: "/test", sourceKind: "local-file", sourceDigest: digest }],
  revision: { id: "r", sequence: 1, timestamp: "2026-01-01T00:00:00Z" },
} as TimelineIr;
const inspect = (tl: TimelineIr, b = brief) => inspectBriefTimelineCoverage(b, acceptCreativeBrief(b), tl);

test("reports exact source coverage across split occurrences, without asserting exported pixels", () => {
  const result = inspect(timeline);
  assert.equal(result.checks[0]?.status, "present");
  assert.match(result.notice, /not.*(render|output)/i);
  const gap = structuredClone(timeline);
  gap.sequence.occurrences[1]!.sourceStartTime = t(2931);
  assert.equal(inspect(gap).checks[0]?.status, "missing");
  const disabled = structuredClone(timeline);
  disabled.sequence.occurrences[1]!.enabled = false;
  assert.equal(inspect(disabled).checks[0]?.status, "missing");
  const beyondEnd = structuredClone(timeline);
  beyondEnd.sequence.occurrences[1]!.startTime = t(2900);
  assert.equal(inspect(beyondEnd).checks[0]?.status, "missing");
});

test("refuses uncertain source identities, unknown source coordinates and stale approval", () => {
  const wrong = structuredClone(timeline);
  wrong.resources[0]!.sourceDigest = "b".repeat(64);
  assert.equal(inspect(wrong).checks[0]?.status, "unavailable");
  const unknown = structuredClone(timeline);
  delete unknown.sequence.occurrences[1]!.sourceStartTime;
  assert.equal(inspect(unknown).checks[0]?.status, "unavailable");
  assert.throws(() => inspectBriefTimelineCoverage({ ...brief, theme: "changed" }, acceptCreativeBrief(brief), timeline), /STALE_BRIEF/);
});
