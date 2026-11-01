import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EditingSessionRepository,
  JsonFileEditingSessionPersistence,
} from "@framekit/headless-application";
import { AgentVideoRuntime, EditingSession, type TimelineIr } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-persistence", name: "Persistence" },
    sequence: {
      id: "sequence-persistence",
      name: "Master",
      durationTime: { value: "30", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-persistence",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "30", timescale: "30" },
        track: 0,
        role: "video",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [],
    revision: { id: "revision-persistence-1", sequence: 4, timestamp: "2026-10-29T00:00:00.000Z" },
  };
}

function payload(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return JSON.parse(content?.[0]?.text ?? "null");
}

test("file persistence reads existing session JSON without rewriting it", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-roundtrip-"));
  try {
    const session = EditingSession.create({ base: timeline(), provider: { id: "final-cut", version: "10.7.1" } });
    const serialized = `${session.serialize()}\n`;
    const path = join(directory, "session-legacy.json");
    await writeFile(path, serialized, "utf8");

    const persistence = new JsonFileEditingSessionPersistence(directory);
    const restored = await persistence.read("session-legacy");

    assert.deepEqual(restored, session.document());
    assert.equal(await readFile(path, "utf8"), serialized);
    await assert.rejects(persistence.create("session-legacy", restored), /SESSION_ALREADY_EXISTS/);
    assert.equal(await readFile(path, "utf8"), serialized);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file persistence fails closed on corrupted or partial session documents", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-corrupt-"));
  try {
    const corrupt = "{\"schemaVersion\":1,\"state\":\"dirty\"}\n";
    const path = join(directory, "session-partial.json");
    await writeFile(path, corrupt, "utf8");
    const persistence = new JsonFileEditingSessionPersistence(directory);

    await assert.rejects(persistence.read("session-partial"), /TIMELINE_IR_INVALID/);
    assert.equal(await readFile(path, "utf8"), corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file persistence reports missing sessions consistently for reads and updates", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-missing-"));
  try {
    const persistence = new JsonFileEditingSessionPersistence(directory);
    const initial = EditingSession.create({ base: timeline() }).document();
    await assert.rejects(persistence.read("missing"), /SESSION_NOT_FOUND: unknown editing session missing/);
    await assert.rejects(persistence.update("missing", initial, initial.desired.revision), /SESSION_NOT_FOUND: unknown editing session missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file persistence validates optimistic revisions before updates", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-conflict-"));
  try {
    const persistence = new JsonFileEditingSessionPersistence(directory);
    const initial = EditingSession.create({ base: timeline(), provider: { id: "final-cut" } }).document();
    await persistence.create("session-conflict", initial);
    const stale = await persistence.read("session-conflict");
    const current = EditingSession.fromJSON(stale);
    current.apply([
      { type: "rename-occurrence", occurrenceId: "occurrence-persistence", name: "Updated" },
    ], stale.desired.revision);
    await persistence.update("session-conflict", current.document(), stale.desired.revision);

    await assert.rejects(
      persistence.update("session-conflict", stale, stale.desired.revision),
      /STALE_CONTEXT: persisted session revision changed before update/,
    );
    assert.equal((await persistence.read("session-conflict")).desired.sequence.occurrences[0]?.name, "Updated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent file updates accept only one transaction for a revision", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-concurrent-"));
  try {
    const persistence = new JsonFileEditingSessionPersistence(directory);
    const initial = EditingSession.create({ base: timeline(), provider: { id: "final-cut" } }).document();
    await persistence.create("session-concurrent", initial);
    const left = EditingSession.fromJSON(initial);
    left.apply([
      { type: "rename-occurrence", occurrenceId: "occurrence-persistence", name: "Left" },
    ], initial.desired.revision);
    const right = EditingSession.fromJSON(initial);
    right.apply([
      { type: "rename-occurrence", occurrenceId: "occurrence-persistence", name: "Right" },
    ], initial.desired.revision);

    const results = await Promise.allSettled([
      persistence.update("session-concurrent", left.document(), initial.desired.revision),
      persistence.update("session-concurrent", right.document(), initial.desired.revision),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = results.find((result) => result.status === "rejected");
    assert.ok(conflict && conflict.status === "rejected");
    assert.match(String(conflict.reason), /STALE_CONTEXT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("application repository restores and idempotently rebinds a stable session", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-rebind-"));
  try {
    const original = timeline();
    const firstProcess = new EditingSessionRepository(new JsonFileEditingSessionPersistence(directory));
    await firstProcess.create({ sessionId: "session-stable", base: original, provider: { id: "final-cut" } });

    const restartedProcess = new EditingSessionRepository(new JsonFileEditingSessionPersistence(directory));
    const restored = await restartedProcess.inspect("session-stable");
    assert.equal(restored.sessionId, "session-stable");
    assert.equal(restored.document.base.project.id, original.project.id);

    const reboundTimeline = structuredClone(original);
    reboundTimeline.revision = { id: "revision-persistence-2", sequence: 5, timestamp: "2026-10-29T00:01:00.000Z" };
    const rebound = await restartedProcess.reconcile("session-stable", { id: "final-cut" }, reboundTimeline);
    const repeatedRebind = await new EditingSessionRepository(new JsonFileEditingSessionPersistence(directory))
      .reconcile("session-stable", { id: "final-cut" }, reboundTimeline);

    assert.equal(rebound.document.state, "rebased");
    assert.equal(repeatedRebind.document.state, "rebased");
    assert.equal(repeatedRebind.document.base.project.id, original.project.id);
    assert.equal(repeatedRebind.document.desired.sequence.id, original.sequence.id);
    assert.equal(repeatedRebind.document.desired.revision.id, rebound.document.desired.revision.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP uses an injected application session repository", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-session-port-injection-"));
  const repository = new EditingSessionRepository(new JsonFileEditingSessionPersistence(directory));
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project",
    projectName: "Fixture",
    timelineId: "fixture-sequence",
    timelineName: "Main",
    clips: [],
  })), { sessionRepository: repository });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-repository-injection", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const created = payload(await client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-injected-port", provider: { id: "final-cut" }, base: timeline() },
    }));
    const restored = payload(await client.callTool({
      name: "session.inspect",
      arguments: { sessionId: "session-injected-port" },
    }));
    assert.equal(created.sessionId, "session-injected-port");
    assert.equal(restored.document.base.project.id, timeline().project.id);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
