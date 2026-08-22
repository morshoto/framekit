import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";
import type { ProjectSnapshot, RuntimeCapabilities } from "@framekit/runtime";

const emptyAnalyzers = {
  speechTranscribe: false,
  speechVad: false,
  audioLoudness: false,
  visualTrack: false,
};

test("capability payloads distinguish metadata-only and canonical-write backends", async () => {
  const metadataOnly = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: {
          editor: {
            projectRead: true,
            timelineSnapshotRead: false,
            timelineWrite: false,
            timelineArtifactWrite: false,
            readAfterWrite: false,
            incrementalChanges: true,
            rollback: false,
            assetDiscovery: false,
            liveStateRead: true,
            playheadWrite: false,
          },
          analyzers: emptyAnalyzers,
        },
      },
    }),
  });
  assert.equal((await metadataOnly.getCapabilities()).editor.canonicalTimelineMode, "metadata-only");

  const canonicalRuntime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Canonical",
    timelineId: "sequence-1",
    timelineName: "Main",
    clips: [],
  }));
  assert.equal(
    (await canonicalRuntime.inspectEditor()).capabilities.editor.canonicalTimelineMode,
    "canonical-write",
  );
});

const canonicalReadCapabilities: RuntimeCapabilities = {
  editor: {
    projectRead: true,
    timelineSnapshotRead: true,
    timelineWrite: false,
    timelineArtifactWrite: false,
    readAfterWrite: false,
    incrementalChanges: true,
    rollback: false,
    assetDiscovery: false,
    liveStateRead: true,
    playheadWrite: false,
    projectCatalogRead: true,
    projectSelection: true,
  },
  analyzers: emptyAnalyzers,
};

const canonicalSnapshot: ProjectSnapshot = {
  projectId: "final-cut:project:stable-project",
  projectName: "Live Canonical Project",
  timeline: {
    id: "final-cut:sequence:stable-sequence",
    name: "Main",
    duration: 8,
    durationTime: { value: "192000", timescale: "24000" },
    clips: [
      {
        id: "final-cut:occurrence:one",
        mediaId: "final-cut:media:shared",
        name: "First use",
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24000" },
        durationTime: { value: "96000", timescale: "24000" },
      },
      {
        id: "final-cut:occurrence:two",
        mediaId: "final-cut:media:shared",
        name: "Second use",
        start: 4,
        duration: 4,
        track: 1,
        startTime: { value: "96000", timescale: "24000" },
        durationTime: { value: "96000", timescale: "24000" },
      },
    ],
    storyElements: [
      { id: "final-cut:occurrence:one", kind: "asset-clip", start: 0, duration: 4, lane: 0, mediaId: "final-cut:media:shared" },
      { id: "final-cut:occurrence:two", kind: "asset-clip", start: 4, duration: 4, lane: 1, mediaId: "final-cut:media:shared" },
    ],
    markers: [],
    captions: [],
  },
  media: [{ mediaId: "final-cut:media:shared", source: "final-cut://media/shared" }],
  revision: { id: "live-rev-7", sequence: 7, timestamp: new Date(7).toISOString() },
};

test("canonical-read live sessions expose complete snapshots with explicit stable targets", async () => {
  const requests: FinalCutLiveRequest[] = [];
  const live = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => {
      requests.push(request);
      const result = {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
      };
      if (request.method === "snapshot") {
        return { version: 1, id: request.id, ok: true, result: { ...result, snapshot: canonicalSnapshot } };
      }
      if (request.method === "projects") {
        return {
          version: 1,
          id: request.id,
          ok: true,
          result: {
            ...result,
            catalog: {
              projects: [{
                id: canonicalSnapshot.projectId,
                name: canonicalSnapshot.projectName,
                sequences: [
                  { id: canonicalSnapshot.timeline.id, name: canonicalSnapshot.timeline.name },
                  { id: "final-cut:sequence:social", name: "Social" },
                ],
              }],
              activeProjectId: canonicalSnapshot.projectId,
              activeSequenceId: canonicalSnapshot.timeline.id,
            },
          },
        };
      }
      if (request.method === "select-project" && !request.sequenceId) {
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: "AMBIGUOUS_PROJECT_TARGET", message: "sequenceId is required" },
        };
      }
      return { version: 1, id: request.id, ok: true, result };
    },
  });
  const session = new FinalCutSessionAdapter({ live });
  const runtime = new AgentVideoRuntime(session);

  assert.equal((await runtime.inspectEditor()).capabilities.editor.canonicalTimelineMode, "canonical-read");
  const inspected = await runtime.inspectProject();
  assert.equal(inspected.timeline.clips.length, 2);
  assert.notEqual(inspected.timeline.clips[0]?.id, inspected.timeline.clips[1]?.id);
  assert.equal(inspected.timeline.clips[0]?.mediaId, inspected.timeline.clips[1]?.mediaId);
  assert.deepEqual(inspected.timeline.storyElements.map(({ id, lane }) => ({ id, lane })), [
    { id: "final-cut:occurrence:one", lane: 0 },
    { id: "final-cut:occurrence:two", lane: 1 },
  ]);
  await assert.rejects(
    runtime.selectProject({ projectId: canonicalSnapshot.projectId }),
    /AMBIGUOUS_PROJECT_TARGET/,
  );
  assert.ok(requests.some(({ method }) => method === "snapshot"));
});
