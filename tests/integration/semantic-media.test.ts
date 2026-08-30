import assert from "node:assert/strict";
import test from "node:test";
import {
  FixtureAudioAnalyzer,
  FixtureMetadataAnalyzer,
  FixtureVisualAnalyzer,
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
    visual: {
      scenes: [{ id: "scene-1", start: 1, end: 4, label: "interview", confidence: 0.95 }],
      subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 1, end: 4 }],
      keyframes: [],
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

test("media understanding preserves successful results when one analyzer cannot analyze", async () => {
  const fixture = semanticFixture();
  const project = await fixture.adapter.readProject();
  project.media[0]!.visual = {
    scenes: [{ id: "scene-1", start: 1, end: 4, label: "interview", confidence: 0.95 }],
    subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 1, end: 4 }],
    keyframes: [],
  };
  project.media[0]!.audio = undefined;
  const adapter = new InMemoryEditorAdapter({
    projectId: project.projectId,
    projectName: project.projectName,
    timelineId: project.timeline.id,
    timelineName: project.timeline.name,
    clips: project.timeline.clips,
    media: project.media,
  });
  const runtime = new AgentVideoRuntime(adapter, {
    audioAnalyzer: new FixtureAudioAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const understanding = await runtime.understandMedia("media-semantic-1");
  const audio = understanding.analysis.find((record) => record.capability === "audio");

  assert.equal(understanding.visual?.subjects[0]?.label, "person");
  assert.equal(audio?.status, "unavailable");
  assert.match(audio?.reason ?? "", /no audio fixture/);
});

test("semantic media index filters by meaning and usable source ranges", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const matches = await runtime.indexMedia({
    subject: "person",
    scene: "interview",
    environment: "studio",
    range: { start: 2, end: 3 },
  });

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.equal(matches[0]?.semantic.subjects[0]?.value, "person");
  assert.deepEqual(matches[0]?.semantic.usableRanges, [fixture.usableRange]);
  assert.equal((await runtime.indexMedia({ subject: "car" })).length, 0);
  assert.equal((await runtime.indexMedia({ range: { start: 5, end: 6 } })).length, 0);
});

test("rough-cut planning returns an explainable read-only shot plan", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const before = await runtime.inspectProject();
  await runtime.understandMedia("media-semantic-1");
  const plan = await runtime.planRoughCut({ subject: "person", maxShots: 1 });
  const shot = plan.shots[0];

  assert.equal(plan.revision.id, before.revision.id);
  assert.equal(plan.shots.length, 1);
  assert.deepEqual(shot?.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.deepEqual(shot?.range, fixture.usableRange);
  assert.deepEqual(shot?.matchedProperties, ["subject:person"]);
  assert.match(shot?.rationale ?? "", /subject "person"/);
});
