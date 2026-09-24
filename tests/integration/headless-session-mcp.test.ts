import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { AgentVideoRuntime, type TimelineIr } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import type { FinalCutSqliteInspectionProvider } from "@framekit/final-cut";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1001", timescale: "24000" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "1001", timescale: "24000" },
        durationTime: { value: "2002", timescale: "24000" },
        sourceStartTime: { value: "1001", timescale: "48000" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [{ id: "media-1", name: "opening.mov", mediaKind: "video", source: "/media/opening.mov" }],
    revision: { id: "revision-1", sequence: 4, timestamp: "2026-09-15T00:00:00.000Z" },
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

async function connect(
  sessionDirectory: string,
  sqliteObservationProvider?: Pick<FinalCutSqliteInspectionProvider, "inspect">,
  sessionChangeSource?: {
    changesSince(revision: TimelineIr["revision"]): Promise<{
      from: TimelineIr["revision"];
      to: TimelineIr["revision"];
    }>;
  },
) {
  const server = createMcpServer(runtime(), {
    sessionDirectory,
    ...(sqliteObservationProvider ? { sqliteObservationProvider } : {}),
    ...(sessionChangeSource ? { sessionChangeSource } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "headless-session-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("creates previews executes and reloads a provider-neutral session", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-mcp-"));
  try {
    const first = await connect(directory);
    const tools = await first.client.listTools();
    for (const name of ["session.create", "session.inspect", "session.edit.preview", "session.edit.execute"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} should be discoverable`);
    }

    const created = payload(await first.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-1", provider: { id: "final-cut", version: "10.7.1" }, base: timeline() },
    }));
    assert.equal(created.sessionId, "session-1");
    assert.equal(created.document.state, "clean");

    const operation = { type: "trim-occurrence", occurrenceId: "occurrence-1", durationTime: { value: "3003", timescale: "24000" } };
    const preview = payload(await first.client.callTool({
      name: "session.edit.preview",
      arguments: { sessionId: "session-1", expectedRevision: timeline().revision, operations: [operation] },
    }));
    assert.equal(preview.after.sequence.occurrences[0].durationTime.value, "1001");
    assert.equal(preview.after.sequence.occurrences[0].durationTime.timescale, "8000");

    const beforeExecute = payload(await first.client.callTool({ name: "session.inspect", arguments: { sessionId: "session-1" } }));
    assert.equal(beforeExecute.document.desired.sequence.occurrences[0].durationTime.value, "2002");

    const executed = payload(await first.client.callTool({
      name: "session.edit.execute",
      arguments: { sessionId: "session-1", expectedRevision: timeline().revision, operations: [operation] },
    }));
    assert.equal(executed.document.state, "dirty");
    assert.equal(executed.document.desired.sequence.occurrences[0].durationTime.value, "1001");
    await first.client.close();
    await first.server.close();

    const second = await connect(directory);
    const restored = payload(await second.client.callTool({ name: "session.inspect", arguments: { sessionId: "session-1" } }));
    assert.equal(restored.document.provider.id, "final-cut");
    assert.equal(restored.document.desired.sequence.occurrences[0].sourceStartTime.timescale, "48000");
    assert.equal(restored.document.desired.sequence.occurrences[0].durationTime.value, "1001");
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes provider drift before preview and execution", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-provider-drift-"));
  const providerRevision = {
    id: "provider-revision-2",
    sequence: 5,
    timestamp: "2026-09-15T00:02:00.000Z",
  };
  const calls: string[] = [];
  try {
    const connected = await connect(directory, undefined, {
      changesSince: async (revision) => {
        calls.push(revision.id);
        return { from: revision, to: providerRevision };
      },
    });
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-provider-drift", provider: { id: "final-cut" }, base: timeline() },
    });

    const operation = { type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Blocked" };
    const preview = await connected.client.callTool({
      name: "session.edit.preview",
      arguments: { sessionId: "session-provider-drift", operations: [operation] },
    });
    assert.equal(preview.isError, true);
    assert.equal(payload(preview).code, "RECONCILIATION_REQUIRED");

    const stale = payload(await connected.client.callTool({
      name: "session.inspect",
      arguments: { sessionId: "session-provider-drift" },
    }));
    assert.equal(stale.document.state, "possibly_stale");
    assert.equal(stale.document.base.revision.id, timeline().revision.id);
    assert.equal(stale.document.desired.sequence.occurrences[0].name, "Opening");

    const execute = await connected.client.callTool({
      name: "session.edit.execute",
      arguments: { sessionId: "session-provider-drift", operations: [operation] },
    });
    assert.equal(execute.isError, true);
    assert.equal(payload(execute).code, "RECONCILIATION_REQUIRED");

    const providerState = timeline();
    providerState.revision = providerRevision;
    providerState.sequence.occurrences[0]!.gainDb = -6;
    const reconciled = payload(await connected.client.callTool({
      name: "session.reconcile",
      arguments: { sessionId: "session-provider-drift", provider: { id: "final-cut" }, providerState },
    }));
    assert.equal(reconciled.reconciliation.status, "rebased");

    const resumed = payload(await connected.client.callTool({
      name: "session.edit.execute",
      arguments: { sessionId: "session-provider-drift", operations: [operation] },
    }));
    assert.equal(resumed.document.state, "rebased");
    assert.equal(resumed.document.desired.sequence.occurrences[0].name, "Blocked");
    assert.deepEqual(calls, [timeline().revision.id, timeline().revision.id, providerRevision.id]);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds read-only SQLite evidence and invalidates only session freshness", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-sqlite-"));
  let digest = "a".repeat(64);
  const sqliteObservationProvider = {
    inspect: async (sourcePath: string) => ({
      status: "partial" as const,
      observation: {
        version: 1 as const,
        backend: "final-cut-sqlite-read-only" as const,
        sourcePath,
        databaseKind: "fcpevent" as const,
        digest,
        schemaVersion: 18,
        userVersion: 0,
        tables: [],
        rowCounts: {},
        collectionTypes: [],
        collectionRows: [],
        metadataRows: [],
        revision: { id: digest, sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
        canonical: false as const,
        coverage: {
          complete: false as const,
          projectIdentity: "partial" as const,
          sequenceIdentity: "unknown" as const,
          clipOccurrences: "unknown" as const,
          mediaIdentity: "partial" as const,
          rationalTiming: "unknown" as const,
          roles: "unknown" as const,
          storylineRelationships: "unknown" as const,
          markersCaptions: "unknown" as const,
          revision: "partial" as const,
        },
      },
      issues: [],
    }),
  };
  try {
    const connected = await connect(directory, sqliteObservationProvider);
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-observed", provider: { id: "final-cut" }, base: timeline() },
    });
    const first = payload(await connected.client.callTool({
      name: "session.observe",
      arguments: { sessionId: "session-observed", sourcePath: "/private/library/CurrentVersion.fcpevent" },
    }));
    assert.equal(first.observation.canonical, false);
    assert.equal(first.observation.digest, digest);
    assert.equal(first.observation.sourcePath, undefined);
    assert.equal(first.change, "observed");
    assert.equal(first.document.state, "clean");

    const unchanged = payload(await connected.client.callTool({
      name: "session.observe",
      arguments: { sessionId: "session-observed", sourcePath: "/private/library/CurrentVersion.fcpevent" },
    }));
    assert.equal(unchanged.change, "unchanged");
    assert.equal(unchanged.document.state, "clean");

    digest = "b".repeat(64);
    const changed = payload(await connected.client.callTool({
      name: "session.observe",
      arguments: { sessionId: "session-observed", sourcePath: "/private/library/CurrentVersion.fcpevent" },
    }));
    assert.equal(changed.change, "changed");
    assert.equal(changed.document.state, "possibly_stale");
    assert.equal(changed.document.desired.sequence.occurrences[0].name, "Opening");

    const status = payload(await connected.client.callTool({ name: "session.status", arguments: { sessionId: "session-observed" } }));
    assert.equal(status.readyToMaterialize, false);
    assert.equal(status.observation.canonical, false);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on stale revisions and provider mismatch before reconciliation", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-reconcile-"));
  try {
    const connected = await connect(directory);
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-safe", provider: { id: "final-cut" }, base: timeline() },
    });

    const stale = await connected.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-safe",
        expectedRevision: { id: "wrong", sequence: 99, timestamp: "2026-09-15T00:00:00.000Z" },
        operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Unsafe" }],
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(payload(stale).code, "STALE_CONTEXT");

    const providerMismatch = await connected.client.callTool({
      name: "session.reconcile",
      arguments: { sessionId: "session-safe", provider: { id: "resolve" }, providerState: timeline() },
    });
    assert.equal(providerMismatch.isError, true);
    assert.equal(payload(providerMismatch).code, "SESSION_PROVIDER_MISMATCH");

    const providerState = timeline();
    providerState.sequence.occurrences[0]!.gainDb = -6;
    providerState.revision = { id: "revision-2", sequence: 5, timestamp: "2026-09-15T00:02:00.000Z" };
    const reconciled = payload(await connected.client.callTool({
      name: "session.reconcile",
      arguments: { sessionId: "session-safe", provider: { id: "final-cut" }, providerState },
    }));
    assert.equal(reconciled.reconciliation.status, "rebased");
    assert.equal(reconciled.document.state, "rebased");
    assert.equal(reconciled.document.desired.sequence.occurrences[0].gainDb, -6);

    const status = payload(await connected.client.callTool({ name: "session.status", arguments: { sessionId: "session-safe" } }));
    assert.equal(status.state, "rebased");
    assert.equal(status.provider.id, "final-cut");
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
