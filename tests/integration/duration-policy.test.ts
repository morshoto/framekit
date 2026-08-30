import assert from "node:assert/strict";
import test from "node:test";
import { planDurationPolicy } from "@framekit/runtime";

test("duration planning recommends a shorter strong edit for ten minutes of requested time and four minutes of footage", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 10 * 60,
    footage: [{
      id: "usable-footage",
      durationSeconds: 4 * 60,
    }],
  });

  assert.equal(plan.policy.constraint, "soft");
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 4 * 60);
  assert.equal(plan.availableFootage.reusableDurationSeconds, 0);
  assert.equal(plan.achievableDurationSeconds, 4 * 60);
  assert.equal(plan.selectedAction, "deliver-shorter-strong-edit");
  assert.deepEqual(plan.durationReport, {
    requestedDurationSeconds: 10 * 60,
    achievableDurationSeconds: 4 * 60,
    actualDurationSeconds: null,
  });
  assert.equal(plan.unmetConstraints[0], "Requested duration exceeds unique usable footage");
  assert.ok(plan.alternatives.some((alternative) => alternative.kind === "request-additional-footage"));
  assert.deepEqual(plan.reusedRanges, []);
});
