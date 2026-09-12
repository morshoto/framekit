import assert from "node:assert/strict";
import test from "node:test";
import { findAvailableReleaseRunner } from "../../scripts/check-release-runner.mjs";

const requiredLabels = ["self-hosted", "macOS", "framekit-release"];

function runner(overrides: Record<string, unknown> = {}) {
  return {
    id: 236,
    name: "framekit-release-mac",
    status: "online",
    busy: false,
    labels: requiredLabels.map((name) => ({ name })),
    ...overrides,
  };
}

test("release runner eligibility accepts an online idle labeled runner", () => {
  const selected = findAvailableReleaseRunner([runner()]);

  assert.equal(selected?.id, 236);
});

test("release runner eligibility ignores busy and offline runners", () => {
  const selected = findAvailableReleaseRunner([
    runner({ id: 1, busy: true }),
    runner({ id: 2, status: "offline" }),
  ]);

  assert.equal(selected, undefined);
});

test("release runner eligibility requires every release label", () => {
  const selected = findAvailableReleaseRunner([
    runner({ labels: requiredLabels.slice(0, -1).map((name) => ({ name })) }),
  ]);

  assert.equal(selected, undefined);
});
