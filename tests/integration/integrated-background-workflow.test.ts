import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { XMLParser } from "fast-xml-parser";
import { createMcpServer, type SessionMaterializationPublisher } from "../../apps/mcp-server/src/server.js";
import { AgentVideoRuntime, type TimelineIr } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
        sourceStartTime: { value: "45", timescale: "30" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [{ id: "media-1", name: "opening.mov", mediaKind: "video", source: "/media/opening.mov" }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
  };
}

function runtime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project",
    projectName: "Fixture",
    timelineId: "fixture-sequence",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
}

function payload(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return JSON.parse(content?.[0]?.text ?? "null");
}

const target = {
  provider: "final-cut" as const,
  libraryUid: "library-1",
  eventUid: "event-1",
  projectUid: "project-1",
  sequenceUid: "sequence-1",
  eventName: "Framekit",
};

function canonicalTarget(request: {
  target: Pick<typeof target, "libraryUid" | "eventUid" | "projectUid" | "sequenceUid">;
  destination: { projectUid: string; sequenceUid: string };
}) {
  return {
    libraryUid: request.target.libraryUid,
    eventUid: request.target.eventUid,
    projectUid: request.destination.projectUid,
    sequenceUid: request.destination.sequenceUid,
  };
}

async function connect(
  directory: string,
  publisher: SessionMaterializationPublisher,
) {
  const server = createMcpServer(runtime(), {
    sessionDirectory: join(directory, "sessions"),
    materializationDirectory: join(directory, "materializations"),
    sessionMaterializationPublisher: publisher,
    sessionChangeSource: {
      changesSince: async (revision) => ({ from: revision, to: revision }),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integrated-background-workflow-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("integrates three edits, versioned artifact handoff, manual change, and continuation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-integrated-background-workflow-"));
  const canonicalByProject = new Map<string, TimelineIr>();
  const publisher: SessionMaterializationPublisher = {
    publish: async (request) => {
      const canonical = structuredClone(request.desired);
      canonical.project.id = request.destination.projectUid;
      canonical.sequence.id = request.destination.sequenceUid;
      canonicalByProject.set(request.destination.projectUid, canonical);
      return {
        state: "completed",
        canonicalReadback: structuredClone(request.desired),
        canonicalTarget: canonicalTarget(request),
        headedNativeVerified: false,
      };
    },
    readCanonicalTarget: async ({ target: requestedTarget }) => {
      const canonical = canonicalByProject.get(requestedTarget.projectUid);
      assert.ok(canonical, `no canonical project for ${requestedTarget.projectUid}`);
      return {
        canonicalReadback: structuredClone(canonical),
        canonicalTarget: structuredClone(requestedTarget),
        delivery: { state: "background", route: "background" },
      };
    },
  };

  try {
    const connected = await connect(directory, publisher);
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-integrated", provider: { id: "final-cut" }, base: timeline() },
    });
    const edited = payload(await connected.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-integrated",
        expectedRevision: timeline().revision,
        operations: [
          { type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Reviewed opening" },
          { type: "trim-occurrence", occurrenceId: "occurrence-1", sourceStartTime: { value: "60", timescale: "30" }, durationTime: { value: "60", timescale: "30" } },
          { type: "add-marker", marker: {
            id: "marker-integrated",
            name: "Checkpoint",
            startTime: { value: "30", timescale: "30" },
            durationTime: { value: "0", timescale: "1" },
          } },
        ],
      },
    }));
    assert.equal(edited.document.desired.sequence.occurrences[0].name, "Reviewed opening");
    assert.deepEqual(edited.document.desired.sequence.occurrences[0].durationTime, { value: "2", timescale: "1" });
    assert.deepEqual(edited.document.desired.sequence.occurrences[0].sourceStartTime, { value: "2", timescale: "1" });
    assert.equal(edited.document.desired.sequence.markers[0].name, "Checkpoint");

    const completed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-integrated", target, confirm: true },
    }));
    assert.equal(completed.state, "completed");
    assert.equal(completed.destination.mode, "versioned");
    assert.notEqual(completed.destination.projectUid, target.projectUid);
    assert.equal(completed.verification.tier, "canonical-verified");
    assert.deepEqual(completed.verification.delivery, { state: "background", route: "background" });
    assert.equal(completed.evidence.headedNative, false);

    const xml = await readFile(completed.artifactPath, "utf8");
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
    const sequence = parsed.fcpxml.library.event.project.sequence;
    assert.equal(sequence.spine["asset-clip"]["@_name"], "Reviewed opening");
    assert.equal(sequence.spine["asset-clip"]["@_duration"], "2s");
    assert.equal(sequence.spine["asset-clip"]["@_start"], "2s");
    assert.equal(sequence.spine.marker["@_value"], "Checkpoint");

    const manual = canonicalByProject.get(completed.destination.projectUid) as TimelineIr;
    manual.sequence.occurrences[0].name = "Manual Final Cut edit";
    manual.revision = { id: "manual-revision", sequence: 2, timestamp: "2026-10-07T00:02:00.000Z" };

    const resynced = payload(await connected.client.callTool({
      name: "session.materialize.resync",
      arguments: { jobId: completed.jobId, sessionId: "session-after-handoff" },
    }));
    assert.equal(resynced.state, "resynced");
    assert.equal(resynced.changeSinceHandoff, "changed");
    assert.equal(resynced.document.base.project.id, completed.destination.projectUid);
    assert.equal(resynced.document.base.sequence.id, completed.destination.sequenceUid);
    assert.equal(resynced.document.base.sequence.occurrences[0].name, "Manual Final Cut edit");
    assert.equal(resynced.document.state, "clean");
    assert.deepEqual(resynced.delivery, { state: "background", route: "background" });

    const continued = payload(await connected.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-after-handoff",
        expectedRevision: resynced.document.base.revision,
        operations: [{ type: "set-gain", occurrenceId: "occurrence-1", gainDb: -3 }],
      },
    }));
    assert.equal(continued.document.state, "dirty");
    assert.equal(continued.document.base.sequence.occurrences[0].name, "Manual Final Cut edit");

    const status = payload(await connected.client.callTool({
      name: "session.materialize.status",
      arguments: { jobId: completed.jobId },
    }));
    assert.equal(status.continuation.state, "resynced");
    assert.equal(status.continuation.sessionId, "session-after-handoff");
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when continuation readback does not match the materialized target", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-integrated-background-ambiguous-"));
  const publisher: SessionMaterializationPublisher = {
    publish: async (request) => ({
      state: "completed",
      canonicalReadback: request.desired,
      canonicalTarget: canonicalTarget(request),
      headedNativeVerified: false,
    }),
    readCanonicalTarget: async ({ target: requestedTarget }) => ({
      canonicalReadback: timeline(),
      canonicalTarget: { ...requestedTarget, projectUid: "wrong-project" },
    }),
  };
  try {
    const connected = await connect(directory, publisher);
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-ambiguous", provider: { id: "final-cut" }, base: timeline() },
    });
    const completed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-ambiguous", target, confirm: true },
    }));
    const resync = await connected.client.callTool({
      name: "session.materialize.resync",
      arguments: { jobId: completed.jobId, sessionId: "session-ambiguous-resync" },
    });
    assert.equal(resync.isError, true);
    assert.equal(payload(resync).code, "MATERIALIZATION_RESYNC_TARGET_MISMATCH");
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
