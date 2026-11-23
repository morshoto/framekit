import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCreativeBrief, assertBriefBinding, type CreativeBrief } from "../../../packages/runtime/src/planning/creative-brief.js";

const brief: CreativeBrief = {
  schemaVersion: 1, id: "interview", version: 1,
  purpose: { kind: "specified", value: "interview short" },
  audience: { kind: "no-preference" },
  durationSeconds: { min: 30, max: 60 },
  aspectRatio: "9:16", theme: "warm", visualDirection: "natural",
  requiredContent: ["introduction"], excludedContent: ["private details"],
  speechPolicy: "preserve meaning", musicPolicy: "none", captionPolicy: "review",
  sourceCoverage: [{ requirement: "introduction", sourceId: "camera", start: 0, end: 10 }],
  inferences: [{ field: "pacing", value: "measured", reason: "interview", accepted: true }],
  reviewPrompts: ["Is the tone warm enough?"],
};

test("acceptance binds every brief field and rejects subsequent changes", () => {
  const accepted = acceptCreativeBrief(brief);
  assertBriefBinding(accepted, structuredClone(brief));
  assert.throws(() => assertBriefBinding(accepted, { ...brief, musicPolicy: "background" }), /STALE_BRIEF/);
  assert.throws(() => assertBriefBinding(accepted, { ...brief, version: 2 }), /STALE_BRIEF/);
});

test("acceptance requires complete coverage and reviewed inferences", () => {
  assert.throws(() => acceptCreativeBrief({ ...brief, sourceCoverage: [] }), /coverage/i);
  assert.throws(() => acceptCreativeBrief({ ...brief, inferences: [{ ...brief.inferences[0]!, accepted: false }] }), /inference/i);
  assert.throws(() => acceptCreativeBrief({ ...brief, durationSeconds: { min: 60, max: 30 } }), /duration/i);
});

test("accepted snapshot is independent of later caller mutation", () => {
  const input = structuredClone(brief);
  const accepted = acceptCreativeBrief(input);
  input.requiredContent.push("closing");
  assert.throws(() => assertBriefBinding(accepted, input), /STALE_BRIEF/);
});
