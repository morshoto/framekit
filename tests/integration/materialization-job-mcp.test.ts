import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [], markers: [], captions: [],
    },
    resources: [{ id: "media-1", name: "opening.mov", mediaKind: "video", source: "/media/opening.mov" }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
  };
}

function runtime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project", projectName: "Fixture", timelineId: "fixture-sequence", timelineName: "Main", clips: [], media: [],
  }));
}

function payload(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return JSON.parse(content?.[0]?.text ?? "null");
}

async function connect(directory: string, publisher?: SessionMaterializationPublisher) {
  const server = createMcpServer(runtime(), {
    sessionDirectory: join(directory, "sessions"),
    materializationDirectory: join(directory, "materializations"),
    ...(publisher ? { sessionMaterializationPublisher: publisher } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "materialization-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const target = { provider: "final-cut", projectUid: "project-1", sequenceUid: "sequence-1", eventName: "Framekit" };

test("previews without mutation and resumes a blocked immutable materialization job", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-1", provider: { id: "final-cut" }, base: timeline() } });
    await first.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-1",
        expectedRevision: timeline().revision,
        operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Opening revised" }],
      },
    });

    const preview = payload(await first.client.callTool({ name: "session.materialize.preview", arguments: { sessionId: "session-1", target } }));
    assert.equal(preview.mutating, false);
    assert.equal(preview.destination.mode, "versioned");
    assert.notEqual(preview.destination.projectUid, target.projectUid);
    await assert.rejects(readdir(join(directory, "materializations")), /ENOENT/);

    const unconfirmed = await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-1", target, confirm: false },
    });
    assert.equal(unconfirmed.isError, true);
    assert.equal(payload(unconfirmed).code, "MATERIALIZATION_CONFIRMATION_REQUIRED");

    const executed = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-1", target, confirm: true },
    }));
    assert.equal(executed.state, "blocked");
    assert.equal(executed.nextAction, "retry");
    assert.equal(executed.evidence.artifact.verified, true);
    assert.equal(executed.evidence.providerRequested, false);
    assert.equal(executed.evidence.canonicalReadback, false);
    assert.equal(executed.evidence.headedNative, false);
    assert.match(executed.artifactPath, /\.fcpxml$/);

    await first.client.close();
    await first.server.close();
    const resumedRequests: string[] = [];
    const second = await connect(directory, {
      publish: async (request) => {
        resumedRequests.push(request.jobId);
        return { state: "completed", canonicalReadback: request.desired, headedNativeVerified: false };
      },
    });
    const restored = payload(await second.client.callTool({
      name: "session.materialize.status",
      arguments: { jobId: executed.jobId },
    }));
    assert.equal(restored.state, "blocked");
    assert.equal(restored.artifactDigest, executed.artifactDigest);
    const resumed = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: executed.jobId },
    }));
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.jobId, executed.jobId);
    assert.deepEqual(resumedRequests, [executed.jobId]);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completes only after matching canonical provider readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-provider-"));
  const published: Array<{ artifactPath: string; projectUid: string }> = [];
  const publisher: SessionMaterializationPublisher = {
    publish: async (request) => {
      published.push({ artifactPath: request.artifactPath, projectUid: request.destination.projectUid });
      return { state: "completed", canonicalReadback: request.desired, headedNativeVerified: false };
    },
  };
  try {
    const connected = await connect(directory, publisher);
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-success", provider: { id: "final-cut" }, base: timeline() } });
    const completed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-success", target, confirm: true },
    }));

    assert.equal(completed.state, "completed");
    assert.equal(completed.evidence.providerRequested, true);
    assert.equal(completed.evidence.canonicalReadback, true);
    assert.equal(completed.evidence.headedNative, false);
    assert.equal(published.length, 1);
    assert.notEqual(published[0]?.projectUid, target.projectUid);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("documents session tools persistence and materialization evidence boundaries", async () => {
  const tools = await readFile("docs/mcp/tools.md", "utf8");
  const architecture = await readFile("docs/architecture/headless-editing-sessions.md", "utf8");

  for (const tool of [
    "session.create",
    "session.observe",
    "session.reconcile",
    "session.materialize.preview",
    "session.materialize.execute",
    "session.materialize.status",
    "session.materialize.retry",
  ]) {
    assert.match(tools, new RegExp(tool.replaceAll(".", "\\.")));
  }
  assert.match(architecture, /FRAMEKIT_STATE_DIR/);
  assert.match(architecture, /canonical: false/);
  assert.match(architecture, /artifact.*provider-requested.*canonical-readback.*headed-native/s);
  assert.match(architecture, /does not write.*SQLite/i);
});
