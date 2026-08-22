import assert from "node:assert/strict";
import test from "node:test";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  FinalCutLiveAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";

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
