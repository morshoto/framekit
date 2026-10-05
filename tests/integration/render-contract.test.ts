import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAMEKIT_RENDER_CONTRACT_VERSION,
  createFramekitRenderPlan,
  createFramekitRenderRequest,
  inferFramekitRenderFeatures,
  type FramekitRenderCapabilityReport,
  type FramekitRenderParameters,
  type TimelineIr,
} from "@framekit/runtime";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-render", name: "Render" },
    sequence: {
      id: "sequence-render",
      name: "Master",
      durationTime: { value: "2", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Source",
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "2", timescale: "1" },
        track: 0,
        mediaId: "media-1",
        gainDb: 3,
        transform: { scaleX: 1.25, scaleY: 1.25 },
      }],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [{
        id: "title-1",
        text: "Hello",
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "1", timescale: "1" },
        lane: 1,
      }],
      transitions: [],
    },
    resources: [{ id: "media-1", name: "Source", mediaKind: "video", sourceKind: "local-file", source: "/tmp/source.mp4" }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function parameters(): FramekitRenderParameters {
  return {
    outputPath: "/tmp/render.mp4",
    format: "mp4",
    width: 1920,
    height: 1080,
    frameRate: { value: "30", timescale: "1" },
    overwrite: false,
  };
}

function capabilities(status: "supported" | "degraded" | "unsupported" = "supported"): FramekitRenderCapabilityReport {
  return {
    renderer: { id: "fixture-renderer", version: "1.0.0" },
    features: {
      "local-media": status,
      "structural-edits": status,
      "audio-gain": status,
      transform: status,
      titles: status,
      "cross-dissolve": status,
    },
  };
}

test("builds a deterministic render request and plan bound to one revision", () => {
  const source = timeline();
  const request = createFramekitRenderRequest({
    timeline: source,
    target: { projectId: source.project.id, sequenceId: source.sequence.id },
    parameters: parameters(),
  });
  assert.equal(request.contractVersion, FRAMEKIT_RENDER_CONTRACT_VERSION);
  assert.deepEqual(inferFramekitRenderFeatures(source), ["local-media", "structural-edits", "audio-gain", "transform", "titles"]);
  const plan = createFramekitRenderPlan(request, capabilities());
  assert.equal(plan.projectRevision.id, source.revision.id);
  assert.equal(plan.projectRevision.sequence, source.revision.sequence);
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(plan.timeline, source);
  assert.deepEqual(plan.parameters, request.parameters);
});

test("rejects stale or mismatched render targets before provider work", () => {
  const source = timeline();
  assert.throws(() => createFramekitRenderRequest({
    timeline: source,
    target: { projectId: "wrong", sequenceId: source.sequence.id },
    parameters: parameters(),
  }), /RENDER_INVALID_REQUEST/);
  assert.throws(() => createFramekitRenderRequest({
    timeline: source,
    target: { projectId: source.project.id, sequenceId: source.sequence.id },
    revision: { ...source.revision, sequence: 2 },
    parameters: parameters(),
  }), /RENDER_STALE_REVISION/);
});

test("blocks unsupported or degraded required semantics explicitly", () => {
  const source = timeline();
  const request = createFramekitRenderRequest({
    timeline: source,
    target: { projectId: source.project.id, sequenceId: source.sequence.id },
    parameters: parameters(),
  });
  assert.throws(() => createFramekitRenderPlan(request, capabilities("unsupported")), /RENDER_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => createFramekitRenderPlan(request, capabilities("degraded")), /RENDER_CAPABILITY_UNAVAILABLE/);
});
