import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime, planDurationPolicy } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

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

test("hard duration planning uses explicitly permitted B-roll reuse and reports its source range", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 300,
    constraint: "hard",
    permissions: { allowReuse: true },
    footage: [
      {
        id: "b-roll",
        durationSeconds: 120,
        usableRanges: [{ startSeconds: 0, endSeconds: 120 }],
        reusable: true,
      },
      { id: "interview", durationSeconds: 60 },
    ],
    actualDurationSeconds: 300,
  });

  assert.equal(plan.selectedAction, "reuse-selected-b-roll");
  assert.equal(plan.availableFootage.uniqueDurationSeconds, 180);
  assert.equal(plan.availableFootage.reusableDurationSeconds, 120);
  assert.equal(plan.achievableDurationSeconds, 300);
  assert.deepEqual(plan.reusedRanges, [{
    footageId: "b-roll",
    sourceRange: { startSeconds: 0, endSeconds: 120 },
    occurrence: 1,
  }]);
  assert.deepEqual(plan.unmetConstraints, []);
  assert.deepEqual(plan.durationReport, {
    requestedDurationSeconds: 300,
    achievableDurationSeconds: 300,
    actualDurationSeconds: 300,
  });
});

test("duration planning never silently selects slow motion or generated assets", () => {
  const plan = planDurationPolicy({
    requestedDurationSeconds: 300,
    permissions: { allowSlowMotion: true, allowGeneratedAssets: true },
    footage: [{ id: "footage", durationSeconds: 180 }],
  });

  assert.equal(plan.selectedAction, "deliver-shorter-strong-edit");
  assert.deepEqual(plan.reusedRanges, []);
  assert.equal(plan.alternatives.find((alternative) => alternative.kind === "slow-motion")?.status, "requires-confirmation");
  assert.equal(plan.alternatives.find((alternative) => alternative.kind === "generated-interstitial")?.status, "requires-confirmation");
});

test("runtime duration planning is read-only and reports the observed actual duration", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "duration-policy-project",
    projectName: "Duration Policy Fixture",
    timelineId: "duration-policy-timeline",
    timelineName: "Main Edit",
    clips: [{ id: "clip-1", name: "Footage", start: 0, duration: 120, track: 1 }],
  }));
  const before = await runtime.inspectProject();

  const plan = runtime.planDuration({
    requestedDurationSeconds: 180,
    actualDurationSeconds: 120,
    footage: [{ id: "footage", durationSeconds: 120 }],
  });

  assert.equal(plan.durationReport.actualDurationSeconds, 120);
  assert.deepEqual(await runtime.inspectProject(), before);
});
