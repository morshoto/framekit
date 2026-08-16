import assert from "node:assert/strict";
import test from "node:test";
import {
  FixtureAudioAnalyzer,
  FixtureSpeechAnalyzer,
  FixtureVisualAnalyzer,
  InMemoryEditorAdapter,
} from "@framekit/testkit";
import { AgentVideoRuntime, type MediaContext } from "@framekit/runtime";

function phase2Fixture() {
  const media: MediaContext = {
    mediaId: "media-1",
    source: "interview.mov",
    speech: { words: [{ text: "hello", start: 0, end: 1, confidence: 0.99 }] },
    audio: { integratedLufs: -18, truePeakDb: -3, silenceMs: 120 },
    visual: {
      scenes: [{ id: "scene-1", start: 0, end: 10, label: "interview", confidence: 0.97 }],
      subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 0, end: 10 }],
      motion: { score: 0.2, label: "low" },
      keyframes: [{ time: 2, source: "interview.mov", labels: ["person"] }],
    },
  };
  return new InMemoryEditorAdapter({
    projectId: "project-2",
    projectName: "Phase 2 Fixture",
    timelineId: "timeline-2",
    timelineName: "Main Edit",
    clips: [{ id: "clip-1", mediaId: media.mediaId, name: "Interview", start: 0, duration: 10, track: 1 }],
    media: [media],
    assets: [
      {
        id: "asset-cross-dissolve",
        kind: "transition",
        name: "Cross Dissolve",
        vendor: "Fixture Effects",
        metadata: { durationFrames: 12 },
        compatibility: { timelineKinds: ["asset-clip"] },
      },
      {
        id: "asset-lower-third",
        kind: "title",
        name: "Lower Third",
        vendor: "Fixture Titles",
        metadata: { supportsRoles: ["dialogue"] },
      },
    ],
  });
}

test("Phase 2 returns incremental context changes without rereading the project", async () => {
  const adapter = phase2Fixture();
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  await runtime.edit({ type: "rename-clip", clipId: "clip-1", name: "Interview - Clean" });

  const originalReadProject = adapter.readProject.bind(adapter);
  adapter.readProject = async () => {
    throw new Error("FULL_SNAPSHOT_SHOULD_NOT_BE_USED");
  };
  const changes = await runtime.contextChangesSince(before.revision);
  adapter.readProject = originalReadProject;

  assert.equal(changes.timeline?.modified[0]?.after?.name, "Interview - Clean");
  assert.equal(changes.stateChanges.length, 0);
  assert.equal(changes.assetChanges.length, 0);
});

test("Phase 2 exposes visual analysis and combined media understanding", async () => {
  const runtime = new AgentVideoRuntime(phase2Fixture(), {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: new FixtureAudioAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const visual = await runtime.analyzeVisual("media-1", { start: 1, end: 3 });
  assert.equal(visual.scenes[0]?.label, "interview");
  assert.equal(visual.keyframes[0]?.time, 2);

  const understanding = await runtime.understandMedia("media-1");
  assert.equal(understanding.speech?.words[0]?.text, "hello");
  assert.equal(understanding.audio?.integratedLufs, -18);
  assert.equal(understanding.visual?.subjects[0]?.label, "person");
  assert.equal(understanding.analysisRevision.id, "rev-0");

  const media = await runtime.inspectMedia("media-1");
  assert.equal(media.analysisRevision, "rev-0");
  assert.equal(media.visual?.scenes[0]?.id, "scene-1");
});

test("Phase 2 searches native assets by text, kind, and vendor", async () => {
  const runtime = new AgentVideoRuntime(phase2Fixture());
  const transitions = await runtime.listAssets({ kind: "transition" });
  assert.deepEqual(transitions.map((asset) => asset.name), ["Cross Dissolve"]);
  assert.deepEqual((await runtime.listAssets({ query: "lower" })).map((asset) => asset.id), ["asset-lower-third"]);
  assert.deepEqual((await runtime.listAssets({ vendor: "Fixture Titles" })).map((asset) => asset.name), ["Lower Third"]);
  assert.deepEqual(await runtime.listAssets({ query: "missing" }), []);
});

test("Phase 2 exposes a queryable agent context", async () => {
  const runtime = new AgentVideoRuntime(phase2Fixture(), {
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });
  const context = await runtime.inspectContext();
  assert.equal(context.revision.id, "rev-0");
  assert.equal(context.project.projectName, "Phase 2 Fixture");
  assert.equal(context.media[0]?.mediaId, "media-1");
  assert.equal(context.recentChanges.from.id, "rev-0");
  assert.equal(context.capabilities.analyzers.visualTrack, true);
});
