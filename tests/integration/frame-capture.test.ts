import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { FixtureVisualAnalyzer, InMemoryEditorAdapter } from "@framekit/testkit";

function frameFixture(options: { withFrame?: boolean } = {}) {
  return new InMemoryEditorAdapter({
    projectId: "project-frame",
    projectName: "Frame Capture Fixture",
    timelineId: "timeline-frame",
    timelineName: "Main Edit",
    clips: [{
      id: "clip-frame",
      mediaId: "media-frame",
      name: "Interview",
      start: 0,
      duration: 10,
      track: 1,
    }],
    media: [{
      mediaId: "media-frame",
      source: "interview.mov",
      visual: {
        scenes: [{ id: "scene-frame", start: 0, end: 10, label: "interview" }],
        subjects: [{ id: "subject-frame", label: "person", confidence: 0.99, start: 0, end: 10 }],
        keyframes: [{ time: 2, source: "interview.mov", labels: ["person"] }],
      },
    }],
    frames: options.withFrame === false ? undefined : [{
      position: { value: "48", timescale: "24" },
      timecode: "00:00:02:00",
      image: {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    }],
  });
}

test("captures a deterministic frame with timeline and clip metadata", async () => {
  const runtime = new AgentVideoRuntime(frameFixture());

  const captured = await runtime.captureFrame({ value: "48", timescale: "24" });

  assert.deepEqual(captured.position, { value: "48", timescale: "24" });
  assert.equal(captured.timecode, "00:00:02:00");
  assert.deepEqual(captured.project, { id: "project-frame", name: "Frame Capture Fixture" });
  assert.deepEqual(captured.sequence, { id: "timeline-frame", name: "Main Edit" });
  assert.deepEqual(captured.clip, {
    id: "clip-frame",
    mediaId: "media-frame",
    name: "Interview",
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "10", timescale: "1" },
    track: 1,
  });
  assert.equal(captured.image.mimeType, "image/png");
  assert.equal(captured.image.data, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
});

test("fails explicitly when frame capture is not configured", async () => {
  const runtime = new AgentVideoRuntime(frameFixture({ withFrame: false }));

  await assert.rejects(
    runtime.captureFrame({ value: "48", timescale: "24" }),
    /CAPABILITY_UNAVAILABLE: timeline frame capture/,
  );
});

test("attaches visual analysis when requested and configured", async () => {
  const runtime = new AgentVideoRuntime(frameFixture(), {
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const captured = await runtime.captureFrame(
    { value: "48", timescale: "24" },
    { analyze: true },
  );

  assert.equal(captured.analysis?.scenes[0]?.label, "interview");
  assert.equal(captured.analysis?.subjects[0]?.label, "person");
  assert.equal(captured.analysis?.keyframes[0]?.time, 2);
});

test("fails explicitly when requested visual analysis is not configured", async () => {
  const runtime = new AgentVideoRuntime(frameFixture());

  await assert.rejects(
    runtime.captureFrame({ value: "48", timescale: "24" }, { analyze: true }),
    /CAPABILITY_UNAVAILABLE: visual analysis/,
  );
});
