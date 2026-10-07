import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  createTimelineIrFromProjectSnapshot,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function payload(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return JSON.parse(content?.[0]?.text ?? "null");
}

function makeRuntime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project",
    projectName: "Fixture",
    timelineId: "fixture-sequence",
    timelineName: "Main",
    frameDuration: { value: "1001", timescale: "24000" },
    clips: [],
    media: [],
  }));
}

async function connect(runtime: AgentVideoRuntime, sessionDirectory: string, options: Parameters<typeof createMcpServer>[1] = {}) {
  const server = createMcpServer(runtime, { sessionDirectory, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "canonical-resync-mcp-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("production timeline readback keeps ordinary sessions off canonical reads and supports explicit resync", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-canonical-resync-mcp-"));
  const runtime = makeRuntime();
  try {
    const initial = await runtime.inspectProject();
    const base = createTimelineIrFromProjectSnapshot(initial, { id: "final-cut" });
    let canonicalReads = 0;
    const inspectProject = runtime.inspectProject.bind(runtime);
    runtime.inspectProject = async () => {
      canonicalReads += 1;
      return inspectProject();
    };
    const connected = await connect(runtime, directory);
    try {
      await connected.client.callTool({
        name: "session.create",
        arguments: { sessionId: "session-readback", provider: { id: "final-cut" }, base },
      });

      const sessionRead = payload(await connected.client.callTool({
        name: "timeline.inspect",
        arguments: { sessionId: "session-readback" },
      }));
      assert.equal(sessionRead.readback.route, "session");
      assert.equal(sessionRead.timeline.revision.id, base.revision.id);
      assert.equal(canonicalReads, 0);

      const canonicalRead = payload(await connected.client.callTool({
        name: "timeline.inspect",
        arguments: { sessionId: "session-readback", requestedCanonical: true },
      }));
      assert.equal(canonicalRead.readback.route, "canonical-resync");
      assert.equal(canonicalRead.readback.reason, "the caller requires a canonical checkpoint");
      assert.equal(canonicalRead.snapshot.id, initial.timeline.id);
      assert.equal(canonicalRead.session.document.state, "rebased");
      assert.equal(canonicalRead.session.document.base.project.id, initial.projectId);
      assert.equal(canonicalReads, 1);
    } finally {
      await connected.client.close();
      await connected.server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production timeline readback escalates changed partial SQLite evidence to canonical resync", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-canonical-resync-sqlite-"));
  const runtime = makeRuntime();
  let digest = "a".repeat(64);
  try {
    const initial = await runtime.inspectProject();
    const base = createTimelineIrFromProjectSnapshot(initial, { id: "final-cut" });
    let canonicalReads = 0;
    const inspectProject = runtime.inspectProject.bind(runtime);
    runtime.inspectProject = async () => {
      canonicalReads += 1;
      return inspectProject();
    };
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
    const connected = await connect(runtime, directory, { sqliteObservationProvider });
    try {
      await connected.client.callTool({
        name: "session.create",
        arguments: { sessionId: "session-sqlite-resync", provider: { id: "final-cut" }, base },
      });
      await connected.client.callTool({
        name: "session.observe",
        arguments: { sessionId: "session-sqlite-resync", sourcePath: "/tmp/framekit/CurrentVersion.fcpevent" },
      });
      digest = "b".repeat(64);
      const observed = payload(await connected.client.callTool({
        name: "session.observe",
        arguments: { sessionId: "session-sqlite-resync", sourcePath: "/tmp/framekit/CurrentVersion.fcpevent" },
      }));
      assert.equal(observed.document.state, "possibly_stale");

      const read = payload(await connected.client.callTool({
        name: "timeline.inspect",
        arguments: { sessionId: "session-sqlite-resync" },
      }));
      assert.equal(read.readback.route, "canonical-resync");
      assert.equal(read.readback.reason, "the editing session requires canonical resync");
      assert.equal(read.session.document.state, "rebased");
      assert.equal(read.session.document.base.revision.id, initial.revision.id);
      assert.equal(read.session.document.observation.digest, "b".repeat(64));
      assert.equal(canonicalReads, 1);
    } finally {
      await connected.client.close();
      await connected.server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
