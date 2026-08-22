import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

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
    media: [{ mediaId: "media-frame", source: "interview.mov" }],
    frames: options.withFrame === false ? undefined : [{
      position: { value: "48", timescale: "24" },
      timecode: "00:00:02:00",
      image: {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
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
  assert.equal(captured.image.data, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");
});

test("fails explicitly when frame capture is not configured", async () => {
  const runtime = new AgentVideoRuntime(frameFixture({ withFrame: false }));

  await assert.rejects(
    runtime.captureFrame({ value: "48", timescale: "24" }),
    /CAPABILITY_UNAVAILABLE: timeline frame capture/,
  );
});
