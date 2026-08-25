import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentVideoRuntime, canonicalSnapshotDigest, canonicalTimelineMode } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";
import type { EditOperation, ProjectCatalog, ProjectSnapshot, RuntimeCapabilities } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const execFile = promisify(execFileCallback);

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
            frameCapture: false,
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

test("canonical capability modes require explicit project catalog and selection guarantees", () => {
  const missingTargetGuarantees: RuntimeCapabilities = {
    ...canonicalReadCapabilities,
    editor: {
      ...canonicalReadCapabilities.editor,
      projectCatalogRead: false,
      projectSelection: false,
    },
  };
  assert.equal(canonicalTimelineMode(missingTargetGuarantees), "metadata-only");
});

test("live adapters reject canonical reads when explicit targeting is unavailable", async () => {
  const capabilities: RuntimeCapabilities = {
    ...canonicalReadCapabilities,
    editor: {
      ...canonicalReadCapabilities.editor,
      projectCatalogRead: false,
      projectSelection: false,
    },
  };
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "incomplete-live-ipc" },
        capabilities,
        ...(request.method === "snapshot" ? { snapshot: canonicalSnapshot } : {}),
      },
    }),
  });

  await assert.rejects(adapter.readProject(), /CAPABILITY_UNAVAILABLE: live Final Cut canonical snapshot targeting/);
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
    frameCapture: false,
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

test("live project selection fails closed on ambiguous or mismatched targets", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
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
    }),
  });

  await assert.rejects(
    adapter.selectProject({ projectId: canonicalSnapshot.projectId }),
    /AMBIGUOUS_PROJECT_TARGET: sequenceId is required/,
  );
  await assert.rejects(
    adapter.selectProject({ projectId: canonicalSnapshot.projectId, sequenceId: "final-cut:sequence:social" }),
    /TARGET_MISMATCH: live project selection did not activate requested target/,
  );
});

test("live project catalogs fail closed on duplicate project identities", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        catalog: {
          projects: [
            { id: "duplicate-project", name: "One", sequences: [] },
            { id: "duplicate-project", name: "Two", sequences: [] },
          ],
        },
      },
    }),
  });

  await assert.rejects(adapter.listProjects(), /FINAL_CUT_LIVE_PROTOCOL: duplicate project id duplicate-project/);
});

test("live project catalogs reject non-object project and sequence entries", async () => {
  const malformedProjectAdapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        catalog: { projects: [null] } as unknown as ProjectCatalog,
      },
    }),
  });

  await assert.rejects(malformedProjectAdapter.listProjects(), /FINAL_CUT_LIVE_PROTOCOL: project must be an object/);

  const malformedSequenceAdapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        catalog: {
          projects: [{ id: "project-1", name: "Project", sequences: [null] }],
        } as unknown as ProjectCatalog,
      },
    }),
  });

  await assert.rejects(
    malformedSequenceAdapter.listProjects(),
    /FINAL_CUT_LIVE_PROTOCOL: sequence in project project-1 must be an object/,
  );
});

test("live project catalogs fail closed on duplicate sequence identities", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        catalog: {
          projects: [
            {
              id: "project-1",
              name: "Project",
              sequences: [
                { id: "duplicate-sequence", name: "One" },
                { id: "duplicate-sequence", name: "Two" },
              ],
            },
          ],
        },
      },
    }),
  });

  await assert.rejects(
    adapter.listProjects(),
    /FINAL_CUT_LIVE_PROTOCOL: duplicate sequence id duplicate-sequence in project project-1/,
  );
});

const canonicalWriteCapabilities: RuntimeCapabilities = {
  ...canonicalReadCapabilities,
  editor: {
    ...canonicalReadCapabilities.editor,
    timelineWrite: true,
    readAfterWrite: true,
    rollback: true,
  },
};

test("live canonical apply rejects a non-advancing resulting revision", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalWriteCapabilities,
        revision: canonicalSnapshot.revision,
      },
    }),
  });

  await assert.rejects(
    adapter.apply(
      { type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Invalid revision" },
      canonicalSnapshot.revision,
    ),
    /FINAL_CUT_LIVE_PROTOCOL: apply response revision must advance expected revision/,
  );
});

test("live canonical apply rejects an unchanged revision id even when sequence advances", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalWriteCapabilities,
        revision: {
          ...canonicalSnapshot.revision,
          sequence: canonicalSnapshot.revision.sequence + 1,
        },
      },
    }),
  });

  await assert.rejects(
    adapter.apply(
      { type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Reused revision id" },
      canonicalSnapshot.revision,
    ),
    /FINAL_CUT_LIVE_PROTOCOL: apply response revision must advance expected revision/,
  );
});

test("live adapter rejects invalid mutation and selection inputs before transport", async () => {
  const requests: FinalCutLiveRequest[] = [];
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => {
      requests.push(request);
      return {
        version: 1,
        id: request.id,
        ok: true,
        result: {
          identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
          capabilities: canonicalWriteCapabilities,
        },
      };
    },
  });

  await assert.rejects(
    adapter.apply(
      { type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Invalid input" },
      { ...canonicalSnapshot.revision, timestamp: "" },
    ),
    /FINAL_CUT_LIVE_PROTOCOL: expected revision timestamp must be a non-empty string/,
  );
  await assert.rejects(
    adapter.selectProject({ projectId: "" }),
    /FINAL_CUT_LIVE_PROTOCOL: selected project id must be a non-empty string/,
  );
  await assert.rejects(
    adapter.selectProject({ projectId: "project-1", sequenceId: " " }),
    /FINAL_CUT_LIVE_PROTOCOL: selected sequence id must be a non-empty string/,
  );
  assert.deepEqual(requests, []);
});

class MutableCanonicalLiveTransport {
  public snapshot = structuredClone(canonicalSnapshot);
  public applyCalls = 0;
  public restoreCalls = 0;
  public failNextSnapshotAfterApply = false;
  private readonly history = new Map<string, ProjectSnapshot>();

  public constructor(private readonly capabilities: RuntimeCapabilities = canonicalWriteCapabilities) {}

  public async request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> {
    const result = {
      identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
      capabilities: this.capabilities,
    };
    if (request.method === "snapshot") {
      if (this.failNextSnapshotAfterApply && this.applyCalls > 0) {
        this.failNextSnapshotAfterApply = false;
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: "CANONICAL_READ_FAILED", message: "synthetic read-after-write failure" },
        };
      }
      return { version: 1, id: request.id, ok: true, result: { ...result, snapshot: structuredClone(this.snapshot) } };
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
              id: this.snapshot.projectId,
              name: this.snapshot.projectName,
              sequences: [{ id: this.snapshot.timeline.id, name: this.snapshot.timeline.name }],
            }],
            activeProjectId: this.snapshot.projectId,
            activeSequenceId: this.snapshot.timeline.id,
          },
        },
      };
    }
    if (request.method === "apply") {
      this.applyCalls += 1;
      if (!sameRevision(request.expectedRevision, this.snapshot.revision)) {
        return staleResponse(request.id);
      }
      this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
      applyOperation(this.snapshot, request.operation!);
      this.advanceRevision();
      return { version: 1, id: request.id, ok: true, result: { ...result, revision: this.snapshot.revision } };
    }
    if (request.method === "restore") {
      this.restoreCalls += 1;
      if (!sameRevision(request.expectedRevision, this.snapshot.revision)) {
        return staleResponse(request.id);
      }
      const previous = this.history.get(request.snapshot!.revision.id);
      if (!previous) {
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: "ROLLBACK_FAILED", message: "snapshot history is unavailable" },
        };
      }
      this.snapshot = structuredClone(previous);
      this.advanceRevision();
    }
    return { version: 1, id: request.id, ok: true, result };
  }

  private advanceRevision(): void {
    const sequence = this.snapshot.revision.sequence + 1;
    this.snapshot.revision = {
      id: `live-rev-${sequence}`,
      sequence,
      timestamp: new Date(sequence).toISOString(),
    };
  }
}

test("read-after-write failure performs compensating rollback with the applied revision", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: new FinalCutLiveAdapter(transport),
  }));
  const before = await runtime.inspectProject();
  transport.failNextSnapshotAfterApply = true;

  await assert.rejects(
    runtime.edit({ type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Unreadable edit" }),
    /READ_AFTER_WRITE_FAILED: canonical state was restored/,
  );
  assert.equal(transport.restoreCalls, 1);
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
});

test("live canonical snapshots fail closed on duplicate occurrence identities", async () => {
  const duplicate = structuredClone(canonicalSnapshot);
  duplicate.timeline.clips[1]!.id = duplicate.timeline.clips[0]!.id;
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        ...(request.method === "snapshot" ? { snapshot: duplicate } : {}),
      },
    }),
  });

  await assert.rejects(adapter.readProject(), /FINAL_CUT_LIVE_PROTOCOL: duplicate timeline occurrence id/);
});

test("live canonical snapshots fail closed when the active target does not match", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
        ...(request.method === "snapshot" ? { snapshot: canonicalSnapshot } : {}),
        ...(request.method === "projects" ? {
          catalog: {
            projects: [{ id: "other-project", name: "Other", sequences: [{ id: "other-sequence", name: "Other" }] }],
            activeProjectId: "other-project",
            activeSequenceId: "other-sequence",
          },
        } : {}),
      },
    }),
  });

  await assert.rejects(adapter.readProject(), /TARGET_MISMATCH: live canonical snapshot/);
});

test("configured artifact providers do not inherit or route canonical live writes", async () => {
  const artifact = new InMemoryEditorAdapter({
    projectId: "artifact-project",
    projectName: "Artifact",
    timelineId: "artifact-sequence",
    timelineName: "Artifact Main",
    clips: [{ id: "artifact-clip", name: "Artifact clip", start: 0, duration: 1, track: 0 }],
  });
  artifact.getCapabilities = async () => ({
    editor: {
      projectRead: true,
      timelineSnapshotRead: true,
      timelineWrite: false,
      timelineArtifactWrite: true,
      readAfterWrite: true,
      incrementalChanges: false,
      rollback: true,
      assetDiscovery: false,
      liveStateRead: false,
      playheadWrite: false,
      frameCapture: false,
      projectCatalogRead: true,
      projectSelection: true,
    },
    analyzers: emptyAnalyzers,
  });
  const liveTransport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    snapshot: artifact,
    mutation: artifact,
    live: new FinalCutLiveAdapter(liveTransport),
  }));

  const inspected = await runtime.inspectEditor();
  assert.equal(inspected.capabilities.editor.canonicalTimelineMode, "canonical-read");
  assert.equal(inspected.capabilities.editor.timelineWrite, false);
  assert.equal(inspected.capabilities.editor.timelineArtifactWrite, true);
  assert.equal((await runtime.listProjects()).activeProjectId, "artifact-project");
  await runtime.edit({ type: "rename-clip", clipId: "artifact-clip", name: "Artifact edited" });
  assert.equal(liveTransport.applyCalls, 0);
});

test("sessions do not advertise or route live writes without rollback", async () => {
  const capabilities: RuntimeCapabilities = {
    ...canonicalWriteCapabilities,
    editor: { ...canonicalWriteCapabilities.editor, rollback: false },
  };
  const transport = new MutableCanonicalLiveTransport(capabilities);
  const session = new FinalCutSessionAdapter({ live: new FinalCutLiveAdapter(transport) });

  assert.equal((await session.getCapabilities()).editor.timelineWrite, false);
  await assert.rejects(
    session.apply(
      { type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Unsafe" },
      canonicalSnapshot.revision,
    ),
    /CAPABILITY_UNAVAILABLE/,
  );
  assert.equal(transport.applyCalls, 0);
});

test("runtime rejects unsafe timeline writes before mutation", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "unsafe-project",
    projectName: "Unsafe",
    timelineId: "unsafe-sequence",
    timelineName: "Unsafe Main",
    clips: [{ id: "unsafe-clip", name: "Unsafe clip", start: 0, duration: 1, track: 0 }],
  });
  const originalApply = adapter.apply.bind(adapter);
  let applyCalls = 0;
  adapter.apply = async (operation, revision) => {
    applyCalls += 1;
    return originalApply(operation, revision);
  };
  adapter.getCapabilities = async () => ({
    editor: {
      projectRead: true,
      timelineSnapshotRead: true,
      timelineWrite: true,
      timelineArtifactWrite: false,
      readAfterWrite: false,
      incrementalChanges: false,
      rollback: false,
      assetDiscovery: false,
      liveStateRead: false,
      playheadWrite: false,
      frameCapture: false,
      projectCatalogRead: true,
      projectSelection: true,
    },
    analyzers: emptyAnalyzers,
  });

  await assert.rejects(
    new AgentVideoRuntime(adapter).edit({ type: "rename-clip", clipId: "unsafe-clip", name: "Changed" }),
    /CAPABILITY_UNAVAILABLE: editor timeline mutation requires snapshot, read-after-write, and rollback/,
  );
  assert.equal(applyCalls, 0);
});

test("canonical digests ignore object-key order but preserve timeline array order", () => {
  const before = structuredClone(canonicalSnapshot);
  const reordered = reverseObjectKeys(structuredClone(before)) as ProjectSnapshot;
  assert.equal(canonicalSnapshotDigest(reordered), canonicalSnapshotDigest(before));

  reordered.timeline.clips.reverse();
  assert.notEqual(canonicalSnapshotDigest(reordered), canonicalSnapshotDigest(before));
});

test("canonical-write live sessions return verified diffs and reject stale writes before mutation", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: new FinalCutLiveAdapter(transport),
  }));
  const base = await runtime.inspectProject();

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Renamed live",
    baseRevision: base.revision,
  });
  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.before.timeline.clips[0]?.name, "First use");
  assert.equal(transaction.after.timeline.clips[0]?.name, "Renamed live");
  assert.equal(transaction.diff.modified[0]?.itemId, "final-cut:occurrence:one");

  const callsBeforeStaleAttempt = transport.applyCalls;
  await assert.rejects(runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Stale rename",
    baseRevision: base.revision,
  }), /STALE_CONTEXT/);
  assert.equal(transport.applyCalls, callsBeforeStaleAttempt);
});

test("failed canonical live verification restores the pre-edit digest", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(
    new FinalCutSessionAdapter({ live: new FinalCutLiveAdapter(transport) }),
    { verificationEngine: { verify: async () => ({ passed: false, checks: [{ name: "forced", passed: false, detail: "test" }] }) } },
  );
  const before = await runtime.inspectProject();

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Must roll back",
  });

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(canonicalSnapshotDigest(transaction.after), canonicalSnapshotDigest(before));
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
});

test("rejected canonical live verification restores the pre-edit digest", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(
    new FinalCutSessionAdapter({ live: new FinalCutLiveAdapter(transport) }),
    { verificationEngine: { verify: async () => { throw new Error("synthetic verifier failure"); } } },
  );
  const before = await runtime.inspectProject();

  await assert.rejects(
    runtime.edit({ type: "rename-clip", clipId: "final-cut:occurrence:one", name: "Verifier throws" }),
    /VERIFICATION_FAILED: canonical state was restored/,
  );
  assert.equal(transport.restoreCalls, 1);
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
});

test("MCP inspects, edits, diffs, and undoes a canonical live timeline", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: new FinalCutLiveAdapter(transport),
  }));
  const client = new Client({ name: "canonical-live-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(runtime);
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "canonical-write");
    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));

    const edited = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit",
      arguments: {
        type: "rename-clip",
        clipId: "final-cut:occurrence:one",
        name: "Edited through MCP",
        baseRevision: before.revision,
      },
    })));
    assert.equal(edited.status, "VERIFIED");
    assert.equal(edited.after.timeline.clips[0].name, "Edited through MCP");

    const diff = JSON.parse(textFrom(await client.callTool({
      name: "edit.diff",
      arguments: { transactionId: edited.id },
    })));
    assert.equal(diff.modified[0].itemId, "final-cut:occurrence:one");

    const restored = JSON.parse(textFrom(await client.callTool({
      name: "edit.undo",
      arguments: { transactionId: edited.id },
    })));
    assert.equal(canonicalSnapshotDigest(restored), canonicalSnapshotDigest(before));
  } finally {
    await client.close();
    await server.close();
  }
});

test("headed canonical live evidence runner fails closed without a disposable target", async () => {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:final-cut-canonical-headed"],
    "node scripts/final-cut-canonical-headed-e2e.mjs",
  );
  const env = { ...process.env };
  delete env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
  delete env.FRAMEKIT_FINAL_CUT_E2E_CLIP_ID;

  await assert.rejects(
    execFile(process.execPath, [join(root, "scripts/final-cut-canonical-headed-e2e.mjs")], { env }),
    (error: unknown) => {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      return /Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_CLIP_ID/.test(stderr);
    },
  );
});

function sameRevision(left: ProjectSnapshot["revision"] | undefined, right: ProjectSnapshot["revision"]): boolean {
  return Boolean(left && left.id === right.id && left.sequence === right.sequence);
}

function staleResponse(id: string): FinalCutLiveResponse {
  return {
    version: 1,
    id,
    ok: false,
    error: { code: "STALE_CONTEXT", message: "revision changed before mutation" },
  };
}

function applyOperation(snapshot: ProjectSnapshot, operation: EditOperation): void {
  if (operation.type !== "rename-clip") throw new Error(`unsupported test operation: ${operation.type}`);
  const clip = snapshot.timeline.clips.find(({ id }) => id === operation.clipId);
  if (!clip) throw new Error(`missing test clip: ${operation.clipId}`);
  clip.name = operation.name;
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first!.text as string;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
}
