import assert from "node:assert/strict";
import test from "node:test";
import { planDialogueGain, type AudioMeasurement } from "@framekit/runtime";

const measurement = (overrides: Partial<AudioMeasurement> = {}): AudioMeasurement => ({
  mediaId: "dialogue-media",
  occurrenceId: "dialogue-clip",
  requestedRange: { start: 0, end: 10 },
  measuredRange: { start: 0, end: 10 },
  revision: { id: "rev-0", sequence: 0, timestamp: "1970-01-01T00:00:00.000Z" },
  provider: { id: "fixture.audio", provider: "fixture", version: "1" },
  dialoguePresent: true,
  integratedLufs: -20,
  truePeakDb: -6,
  silenceMs: 100,
  analyzedDurationSeconds: 10,
  valid: true,
  ...overrides,
});

const defaults = {
  targetLufs: -16,
  toleranceDb: 0.5,
  maxTruePeakDb: -1,
  minGainDb: -6,
  maxGainDb: 6,
  minDialogueDurationSeconds: 1,
};

test("quiet dialogue produces a deterministic APPLY gain plan", () => {
  assert.deepEqual(planDialogueGain(measurement(), defaults), {
    decision: "APPLY",
    targetLufs: -16,
    toleranceDb: 0.5,
    maxTruePeakDb: -1,
    minGainDb: -6,
    maxGainDb: 6,
    minDialogueDurationSeconds: 1,
    currentLufs: -20,
    desiredGainDb: 4,
    clampedGainDb: 4,
    estimatedPeakDb: -2,
    reasonCodes: ["APPLY_GAIN"],
  });
});

test("loud dialogue produces a negative APPLY gain plan", () => {
  const plan = planDialogueGain(measurement({ integratedLufs: -12, truePeakDb: -2 }), defaults);

  assert.equal(plan.decision, "APPLY");
  assert.equal(plan.desiredGainDb, -4);
  assert.equal(plan.clampedGainDb, -4);
  assert.equal(plan.estimatedPeakDb, -6);
});

test("already-normalized dialogue produces a NO_OP plan", () => {
  const plan = planDialogueGain(measurement({ integratedLufs: -16, truePeakDb: -3 }), defaults);

  assert.equal(plan.decision, "NO_OP");
  assert.equal(plan.clampedGainDb, 0);
  assert.deepEqual(plan.reasonCodes, ["ALREADY_IN_TOLERANCE"]);
});

test("silent, missing, and too-short dialogue produce structured SKIP plans", () => {
  for (const [overrides, reason] of [
    [{ silenceMs: 10_000 }, "SILENCE"],
    [{ dialoguePresent: false }, "NO_DIALOGUE"],
    [{ analyzedDurationSeconds: 0.5 }, "DIALOGUE_TOO_SHORT"],
  ] as const) {
    const plan = planDialogueGain(measurement(overrides), defaults);
    assert.equal(plan.decision, "SKIP");
    assert.deepEqual(plan.reasonCodes, [reason]);
  }
});

test("gain outside the configured clamp produces a non-mutating SKIP", () => {
  const plan = planDialogueGain(measurement({ integratedLufs: -30 }), defaults);

  assert.equal(plan.decision, "SKIP");
  assert.equal(plan.desiredGainDb, 14);
  assert.equal(plan.clampedGainDb, 6);
  assert.deepEqual(plan.reasonCodes, ["GAIN_OUT_OF_BOUNDS"]);
});

test("estimated peak over the configured limit produces a non-mutating SKIP", () => {
  const plan = planDialogueGain(measurement({ truePeakDb: -2 }), {
    ...defaults,
    maxTruePeakDb: -1,
    maxGainDb: 6,
  });

  assert.equal(plan.decision, "SKIP");
  assert.equal(plan.estimatedPeakDb, 2);
  assert.deepEqual(plan.reasonCodes, ["PEAK_RISK"]);
});

test("invalid measurements cannot produce APPLY", () => {
  const plan = planDialogueGain(measurement({ valid: false, invalidReason: "provider returned NaN" }), defaults);

  assert.equal(plan.decision, "SKIP");
  assert.deepEqual(plan.reasonCodes, ["MEASUREMENT_INVALID"]);
});
