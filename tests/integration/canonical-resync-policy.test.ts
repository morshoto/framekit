import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseTimelineReadback,
  type TimelineReadbackRequest,
} from "../../apps/mcp-server/src/readback-policy.js";

function request(overrides: Partial<TimelineReadbackRequest> = {}): TimelineReadbackRequest {
  return {
    hasCanonicalBase: true,
    requestedCanonical: false,
    finalVerification: false,
    sessionState: "clean",
    fastObservation: { available: true, coverageComplete: true, status: "unchanged" },
    ...overrides,
  };
}

test("readback policy keeps fresh agent loops off headed canonical export", () => {
  assert.deepEqual(chooseTimelineReadback(request()), {
    route: "fast-observation",
    reason: "fast observation is complete and reconciled",
  });
  assert.deepEqual(chooseTimelineReadback(request({
    fastObservation: { available: false, coverageComplete: false, status: "unavailable" },
  })), {
    route: "session",
    reason: "the bound session remains usable without a fresh observation",
  });
});

test("readback policy forces canonical resync for initial, stale, conflict, and explicit checks", () => {
  for (const input of [
    request({ hasCanonicalBase: false }),
    request({ requestedCanonical: true }),
    request({ finalVerification: true }),
    request({ sessionState: "possibly_stale" }),
    request({ sessionState: "conflicted" }),
    request({ fastObservation: { available: true, coverageComplete: false, status: "possibly-stale" } }),
  ]) {
    assert.equal(chooseTimelineReadback(input).route, "canonical-resync");
  }
});

test("readback policy exposes non-canonical fast conflicts instead of upgrading them", () => {
  const result = chooseTimelineReadback(request({
    fastObservation: { available: true, coverageComplete: true, status: "conflicted" },
  }));
  assert.deepEqual(result, {
    route: "canonical-resync",
    reason: "fast observation reported a conflict",
  });
});
