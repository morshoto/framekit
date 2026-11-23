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
  speechPolicy: { kind: "specified", value: "preserve meaning" }, musicPolicy: { kind: "specified", value: "none" }, captionPolicy: { kind: "specified", value: "review" },
  sourceCoverage: [{ requirement: "introduction", sourceId: "camera", start: 0, end: 10 }],
  inferences: [{ field: "pacing", value: "measured", reason: "interview", accepted: true }],
  reviewPrompts: ["Is the tone warm enough?"],
};

test("acceptance binds every brief field and rejects subsequent changes", () => {
  const accepted = acceptCreativeBrief(brief);
  assertBriefBinding(accepted, structuredClone(brief));
  assert.throws(() => assertBriefBinding(accepted, { ...brief, musicPolicy: { kind: "specified", value: "background" } }), /STALE_BRIEF/);
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

test("review exposes missing coverage and pending inferences before acceptance", async () => {
  const { reviewCreativeBrief } = await import("../../../packages/runtime/src/planning/creative-brief.js");
  const draft = { ...brief, sourceCoverage: [], inferences: [{ ...brief.inferences[0]!, accepted: false }] };
  assert.deepEqual(reviewCreativeBrief(draft), { missingCoverage: ["introduction"], pendingInferences: ["pacing"] });
  assert.throws(() => acceptCreativeBrief(draft), /coverage|inference/i);
});

test("revision preserves identity, advances version and invalidates prior approval", async () => {
  const { reviseCreativeBrief } = await import("../../../packages/runtime/src/planning/creative-brief.js");
  const accepted = acceptCreativeBrief(brief);
  const revised = reviseCreativeBrief(brief, { ...brief, musicPolicy: { kind: "specified", value: "background" } });
  assert.equal(revised.id, brief.id);
  assert.equal(revised.version, 2);
  assert.throws(() => assertBriefBinding(accepted, revised), /STALE_BRIEF/);
  assert.throws(() => reviseCreativeBrief(brief, { ...brief, id: "other" }), /identity/i);
});

test("invalid or malformed drafts fail closed", () => {
  for (const patch of [
    { durationSeconds: null }, { requiredContent: null }, { inferences: null },
    { sourceCoverage: [{ requirement: "introduction", sourceId: "camera", start: 0, end: Infinity }] },
    { musicPolicy: "" }, { version: 1.5 },
  ]) {
    assert.throws(() => acceptCreativeBrief({ ...brief, ...patch } as CreativeBrief), /INVALID_BRIEF/);
  }
});

test("explicit no preference is distinguishable from missing audio choices", () => {
  const input = { ...brief, musicPolicy: { kind: "no-preference" }, captionPolicy: { kind: "specified", value: "review" } };
  assert.doesNotThrow(() => acceptCreativeBrief(input as unknown as CreativeBrief));
  assert.throws(() => acceptCreativeBrief({ ...input, musicPolicy: undefined } as unknown as CreativeBrief), /INVALID_BRIEF/);
});

test("brief identity is stable across object key ordering", () => {
  const reordered = { ...brief, purpose: { value: "interview short", kind: "specified" } } as CreativeBrief;
  assert.deepEqual(acceptCreativeBrief(brief), acceptCreativeBrief(reordered));
});
