import assert from "node:assert/strict";
import test from "node:test";
import {
  FixtureMetadataAnalyzer,
  InMemoryEditorAdapter,
} from "@framekit/testkit";
import { AgentVideoRuntime, type MediaContext } from "@framekit/runtime";

function semanticFixture() {
  const usableRange = {
    start: 1,
    end: 4,
    startTime: { value: "100", timescale: "100" },
    durationTime: { value: "300", timescale: "100" },
  };
  const media: MediaContext = {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
    metadata: {
      environments: [{ value: "studio", confidence: 0.91 }],
      timeOfDay: [{ value: "day", confidence: 0.88 }],
      moods: [{ value: "focused", confidence: 0.86 }],
      usableRanges: [usableRange],
    },
  };
  return {
    usableRange,
    adapter: new InMemoryEditorAdapter({
      projectId: "project-semantic",
      projectName: "Semantic Fixture",
      timelineId: "timeline-semantic",
      timelineName: "Main Edit",
      clips: [{ id: "clip-semantic-1", mediaId: media.mediaId, name: "Interview", start: 0, duration: 12, track: 1 }],
      media: [media],
    }),
  };
}

test("media understanding preserves source identity and analyzer provenance", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
  });

  const understanding = await runtime.understandMedia("media-semantic-1");
  const metadata = understanding.analysis.find((record) => record.capability === "metadata");

  assert.deepEqual(understanding.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.equal(metadata?.status, "analyzed");
  assert.equal(metadata?.provenance?.analyzer.provider, "fixture");
  assert.deepEqual(metadata?.provenance?.source, understanding.sourceIdentity);
  assert.deepEqual(metadata?.provenance?.ranges, [fixture.usableRange]);
});
