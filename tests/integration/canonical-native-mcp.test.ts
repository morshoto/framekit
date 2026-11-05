import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FinalCutCanonicalNativeProvider,
  FinalCutNativeAutomationAdapter,
  FileCanonicalRecoveryGuard,
  FinalCutProjectPublisher,
  type NativeFinalCutEditor,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type ContextRevision,
  type EditorChange,
  type EditorIdentity,
  type EditorLiveState,
  type ProjectSnapshot,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { finalCutMcpEnvironment } from "./final-cut-test-env.js";

const identity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

function snapshot(clipName: string): ProjectSnapshot {
  return {
    projectId: "final-cut:project:canonical-mcp",
    projectName: "Canonical MCP",
    timeline: {
      id: "final-cut:sequence:canonical-mcp",
      name: "Main Edit",
      duration: 4,
      durationTime: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [{
        id: "final-cut:occurrence:clip-1",
        mediaId: "final-cut:media:media-1",
        name: clipName,
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
      }],
      storyElements: [{
        id: "final-cut:occurrence:clip-1",
        kind: "asset-clip",
        start: 0,
        duration: 4,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
        lane: 0,
        mediaId: "final-cut:media:media-1",
      }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "final-cut:media:media-1", source: "/tmp/canonical-clip.mov" }],
    revision: { id: "source-revision", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function liveState(): EditorLiveState {
  return {
    project: { id: "final-cut:project:canonical-mcp", name: "Canonical MCP" },
    sequence: {
      id: "final-cut:sequence:canonical-mcp",
      name: "Main Edit",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function createRuntime(
  calls: string[],
  readSnapshot?: () => Promise<ProjectSnapshot>,
  currentLiveState: () => EditorLiveState = liveState,
) {
  let clipName = "Original";
  const snapshotReader = readSnapshot ?? (async () => snapshot(clipName));
  const live = {
    getIdentity: async () => identity,
    readLiveState: async () => structuredClone(currentLiveState()),
    liveChangesSince: async (_revision: ContextRevision, _waitMs?: number): Promise<EditorChange[]> => [],
  };
  const provider = new FinalCutCanonicalNativeProvider({
    live,
    native: {
      renameSelectedClip: async (name) => {
        calls.push("edit");
        clipName = name;
        return { operationId: "native-operation-1", undoAvailable: true };
      },
      undo: async () => {
        calls.push("undo");
        clipName = "Original";
        return { undone: true, verification: { verified: true } };
      },
    },
    readSnapshot: snapshotReader,
    resolveTarget: Object.assign(async () => undefined, { sourceBindingAvailable: true }),
    backgroundCatalog: {
      backend: "final-cut-background-library",
      listProjects: async () => ({
        projects: [{
          id: "final-cut:project:canonical-mcp",
          name: "Canonical MCP",
          sequences: [{ id: "final-cut:sequence:canonical-mcp", name: "Main Edit" }],
        }],
        activeProjectId: "final-cut:project:canonical-mcp",
        activeSequenceId: "final-cut:sequence:canonical-mcp",
      }),
    },
  });
  return new AgentVideoRuntime(new FinalCutSessionAdapter({ live: provider }));
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

async function connect(runtime: AgentVideoRuntime, options?: Parameters<typeof createMcpServer>[1]) {
  const server = createMcpServer(runtime, options);
  const client = new Client({ name: "canonical-native-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("MCP recovery inspection reports checkpoint evidence without touching the editor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-recovery-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls, async () => { throw new Error("unexpected canonical read"); }), { canonicalRecovery: guard });
  try {
    const clear = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.deepEqual(JSON.parse(textFrom(clear)), { status: "clear", scope: "configured-state-directory" });
    const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" };
    await guard.begin(checkpoint);
    const pending = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.deepEqual(JSON.parse(textFrom(pending)), { status: "recovery-required", scope: "configured-state-directory", checkpointId: (await guard.inspectVersioned())!.checkpointId, checkpoint });
    assert.doesNotMatch(textFrom(pending), /owner/);
    await writeFile(path, "invalid");
    const invalid = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(invalid.isError, true);
    assert.match(textFrom(invalid), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview requires exact consent and never clears the checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-recovery-preview-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  let reads = 0;
  const original = snapshot("Original");
  const target = { projectId: original.projectId, sequenceId: original.timeline.id };
  const checkpoint = { ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(original), operation: "rename-clip" };
  await guard.begin(checkpoint);
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  const { client, server } = await connect(createRuntime(calls, async () => { reads += 1; return structuredClone(original); }), { canonicalRecovery: guard });
  try {
    const listed = (await client.listTools()).tools.find(({ name }) => name === "editor.native.recovery.preview");
    assert.match(listed?.description ?? "", /confirmation alone does not establish authorization/i);
    const missing = await client.callTool({ name: "editor.native.recovery.preview", arguments: { expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(missing.isError, true);
    assert.match(textFrom(missing), /HEADED_READ_CONFIRMATION_REQUIRED/);
    const wrong = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: { ...target, sequenceId: "other" }, expectedCheckpointId: checkpointId } });
    assert.equal(wrong.isError, true);
    assert.match(textFrom(wrong), /TARGET_MISMATCH/);
    const stale = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: "0".repeat(64) } });
    assert.equal(stale.isError, true);
    assert.match(textFrom(stale), /CHECKPOINT_MISMATCH/);
    assert.equal(reads, 0);
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError ?? false, false, textFrom(result));
    const evidence = JSON.parse(textFrom(result));
    assert.equal(evidence.checkpointId, checkpointId);
    assert.equal(evidence.comparison, "matches-before");
    assert.equal(evidence.quiescence, "unproven");
    assert.equal(evidence.pointInTime, true);
    assert.equal(typeof evidence.observedRevision.id, "string");
    assert.equal(evidence.observedLiveRevision.id, "live-revision");
    assert.equal(evidence.observedLiveRevision.sequence, 1);
    assert.equal(evidence.checkpointCleared, false);
    assert.equal(reads, 1, "one confirmed preview must not export twice");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview reports restoration matches and differences without clearing", async () => {
  for (const [observedName, expectedComparison] of [["Original", "matches-expected-restoration"], ["Different", "different"]] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-comparison-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
    const original = snapshot("Original");
    const target = { projectId: original.projectId, sequenceId: original.timeline.id };
    await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: "a".repeat(64), operation: "undo", expectedRestoreDigest: canonicalSnapshotDigest(original) });
    const checkpointId = (await guard.inspectVersioned())!.checkpointId;
    const { client, server } = await connect(createRuntime([], async () => snapshot(observedName)), { canonicalRecovery: guard });
    try {
      const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
      assert.equal(result.isError ?? false, false, textFrom(result));
      assert.equal(JSON.parse(textFrom(result)).comparison, expectedComparison);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("MCP recovery preview rejects a live target mismatch before canonical read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-wrong-live-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const original = snapshot("Original");
  const target = { projectId: original.projectId, sequenceId: "different-sequence" };
  await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(original), operation: "rename-clip" });
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  let reads = 0;
  const { client, server } = await connect(createRuntime([], async () => { reads += 1; return original; }), { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /TARGET_MISMATCH/);
    assert.equal(reads, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview rejects a canonical snapshot with a different target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-wrong-snapshot-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const original = snapshot("Original");
  const other = structuredClone(original);
  other.projectId = "different-project";
  const target = { projectId: original.projectId, sequenceId: original.timeline.id };
  await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(other), operation: "rename-clip" });
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  const runtime = createRuntime([]);
  runtime.inspectProject = async () => structuredClone(other);
  const { client, server } = await connect(runtime, { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /TARGET_MISMATCH/);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview rejects live revision drift around the snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-drift-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const original = snapshot("Original");
  const target = { projectId: original.projectId, sequenceId: original.timeline.id };
  await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(original), operation: "rename-clip" });
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  const active = liveState();
  const runtime = createRuntime([], undefined, () => active);
  const inspectProject = runtime.inspectProject.bind(runtime);
  runtime.inspectProject = async () => {
    const result = await inspectProject();
    assert.ok(active.revision);
    active.revision.id = "external-change";
    active.revision.sequence += 1;
    return result;
  };
  const { client, server } = await connect(runtime, { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /STALE_CONTEXT/);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview rejects a checkpoint replaced during read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-replaced-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const original = snapshot("Original");
  const target = { projectId: original.projectId, sequenceId: original.timeline.id };
  const checkpoint = { ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(original), operation: "rename-clip" };
  await guard.begin(checkpoint);
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  let replaced = false;
  const { client, server } = await connect(createRuntime([], async () => {
    if (!replaced) { replaced = true; await guard.complete(); await guard.begin(checkpoint); }
    return structuredClone(original);
  }), { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(textFrom(result)).code, "CHECKPOINT_MISMATCH");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview rejects incomplete canonical observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-incomplete-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const original = snapshot("Original");
  const target = { projectId: original.projectId, sequenceId: original.timeline.id };
  await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: canonicalSnapshotDigest(original), operation: "rename-clip" });
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  let reads = 0;
  const { client, server } = await connect(createRuntime([], async () => { reads += 1; throw new Error("incomplete canonical observation"); }), { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(textFrom(result)).code, "CAPABILITY_UNAVAILABLE");
    assert.equal(reads, 1);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery preview does not promote a fixture provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-unsupported-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const target = { projectId: "fixture-project", sequenceId: "fixture-sequence" };
  await guard.begin({ ...target, baseRevision: "baseline", beforeDigest: "a".repeat(64), operation: "rename-clip" });
  const checkpointId = (await guard.inspectVersioned())!.checkpointId;
  const adapter = new InMemoryEditorAdapter({ projectId: target.projectId, projectName: "Fixture", timelineId: target.sequenceId, timelineName: "Main", clips: [] });
  let reads = 0;
  const readProject = adapter.readProject.bind(adapter);
  adapter.readProject = async () => { reads += 1; return readProject(); };
  const { client, server } = await connect(new AgentVideoRuntime(adapter), { canonicalRecovery: guard });
  try {
    const result = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: target, expectedCheckpointId: checkpointId } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /CAPABILITY_UNAVAILABLE/);
    assert.equal(reads, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live MCP observes checkpoints when the canonical provider is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-live-config-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "canonical-recovery", "pending.json"));
  const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" };
  await guard.begin(checkpoint);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "apps/mcp-server/src/main.ts")],
    env: finalCutMcpEnvironment({
      FRAMEKIT_STATE_DIR: directory,
      FRAMEKIT_FINAL_CUT_HEADLESS: "1",
      FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
      FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "",
      FRAMEKIT_FINAL_CUT_CANONICAL_REQUIRED: "0",
      FRAMEKIT_FCPXML_PATH: "",
      FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "recovery-live-config-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(response.isError ?? false, false, textFrom(response));
    const result = JSON.parse(textFrom(response));
    assert.equal(result.status, "recovery-required");
    assert.deepEqual(result.checkpoint, checkpoint);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unresolved checkpoint blocks direct native edits while allowing inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-direct-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const nativeEditor = {
    capabilities: () => ({}),
    inspect: async () => ({ available: true }),
    edit: async () => { calls.push("edit"); return { operationId: "native-edit" }; },
    undo: async () => { calls.push("undo"); return { undone: true }; },
    previewBlade: async () => { calls.push("previewBlade"); return {}; },
    executeBlade: async () => { calls.push("executeBlade"); return {}; },
    importMedia: async () => { calls.push("importMedia"); return {}; },
  } as unknown as NativeFinalCutEditor;
  await guard.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const inspection = await client.callTool({ name: "editor.native.inspect", arguments: {} });
    assert.equal(inspection.isError ?? false, false);
    const edit = await client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
    assert.equal(edit.isError, true);
    assert.match(textFrom(edit), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const undo = await client.callTool({ name: "editor.native.undo", arguments: { operationId: "native-edit" } });
    assert.equal(undo.isError, true);
    assert.match(textFrom(undo), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    for (const request of [
      { name: "editor.native.blade.preview", arguments: { occurrenceHandle: "clip-1" } },
      { name: "editor.native.blade.execute", arguments: { previewToken: "token" } },
      { name: "editor.native.media.import", arguments: { path: "/fixture/clip.mov" } },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true, request.name);
      assert.match(textFrom(result), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/, request.name);
    }
    assert.deepEqual(calls, []);
    await guard.complete();
    const allowed = await client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
    assert.equal(allowed.isError ?? false, false, textFrom(allowed));
    assert.deepEqual(calls, ["edit"]);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unresolved checkpoint blocks native jobs and publishing but permits status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-routes-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const nativeOperationSession = {
    submit: async () => { calls.push("submit"); return { state: "accepted" }; },
    retry: async () => { calls.push("retry"); return { state: "accepted" }; },
    status: async () => ({ state: "waiting" }),
    cancel: async () => ({ state: "cancelled" }),
  };
  const disposableNative = {
    preview: async () => { calls.push("preview"); return {}; },
    execute: async () => { calls.push("execute"); return {}; },
    undo: async () => { calls.push("undo"); return {}; },
  };
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state: "verification-pending" }),
    loadPublishJob: async () => ({ state: "verification-pending" }),
    executePublishJob: async () => { calls.push("publish"); return {}; },
  };
  const publisher = { publish: async () => { calls.push("materialize"); return { state: "blocked" }; } };
  await guard.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" });
  const options = {
    canonicalRecovery: guard, nativeOperationSession, disposableNative, projectPublisher,
    sessionMaterializationPublisher: publisher,
    sessionDirectory: join(directory, "sessions"), materializationDirectory: join(directory, "materializations"),
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>;
  const { client, server } = await connect(createRuntime([]), options);
  try {
    const status = await client.callTool({ name: "editor.native.operation.status", arguments: { jobId: "job-1" } });
    assert.equal(status.isError ?? false, false);
    const cancel = await client.callTool({ name: "editor.native.operation.cancel", arguments: { jobId: "job-1" } });
    assert.equal(cancel.isError ?? false, false);
    const publishStatus = await client.callTool({ name: "artifact.publish.status", arguments: { jobId: "job-1" } });
    assert.equal(publishStatus.isError ?? false, false);
    const requests = [
      { name: "editor.native.operation.submit", arguments: { operation: "disposable.rename-clip", previewToken: "token", projectId: "project-1", sequenceId: "sequence-1", targetIdentity: "clip-1", baseRevision: { id: "revision-1", sequence: 1, timestamp: new Date(0).toISOString() }, idempotencyKey: "key-1" } },
      { name: "editor.native.operation.retry", arguments: { jobId: "job-1" } },
      { name: "editor.native.disposable.preview", arguments: { clipId: "clip-1", name: "Review" } },
      { name: "editor.native.disposable.execute", arguments: { previewToken: "token" } },
      { name: "editor.native.disposable.undo", arguments: { operationId: "operation-1" } },
      { name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } },
      { name: "session.materialize.execute", arguments: { sessionId: "session-1", target: { provider: "final-cut", libraryUid: "library-1", eventUid: "event-1", projectUid: "project-1", sequenceUid: "sequence-1" }, confirm: true } },
      { name: "session.materialize.retry", arguments: { jobId: "job-1" } },
    ];
    for (const request of requests) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true, request.name);
      assert.match(textFrom(result), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/, request.name);
    }
    assert.deepEqual(calls, []);
    await guard.complete();
    const retry = await client.callTool({ name: "editor.native.operation.retry", arguments: { jobId: "job-1" } });
    assert.equal(retry.isError ?? false, false, textFrom(retry));
    assert.deepEqual(calls, ["retry"]);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery inspection reports unavailable without a configured checkpoint", async () => {
  const { client, server } = await connect(createRuntime([]));
  try {
    const response = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(response.isError, true);
    assert.match(textFrom(response), /CAPABILITY_UNAVAILABLE/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical native provider exposes reads without selection", async () => {
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls));

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.identity.backend, "final-cut-native-canonical");
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "metadata-only");
    assert.equal(editor.capabilities.editor.projectCatalogRead, true);
    assert.equal(editor.capabilities.editor.projectSelection, false);
    assert.equal(editor.capabilities.editor.projectRead, false);
    assert.equal(editor.capabilities.editor.timelineSnapshotRead, false);
    assert.equal(editor.capabilities.editor.timelineWrite, false);

    const selection = await client.callTool({
      name: "project.select",
      arguments: {
        projectId: "final-cut:project:canonical-mcp",
        sequenceId: "final-cut:sequence:canonical-mcp",
      },
    });
    assert.equal(selection.isError, true);
    assert.deepEqual(JSON.parse(textFrom(selection)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "project.select requires editor.projectSelection",
      operation: "project.select",
      capability: "editor.projectSelection",
      available: false,
      backend: "final-cut-native-canonical",
      guarantee: "none",
      unavailableReason: "project selection is unavailable",
    });

    const catalog = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} })));
    assert.deepEqual(catalog.projects, [{
      id: "final-cut:project:canonical-mcp",
      name: "Canonical MCP",
      sequences: [{ id: "final-cut:sequence:canonical-mcp", name: "Main Edit" }],
    }]);
    assert.equal(catalog.activeProjectId, "final-cut:project:canonical-mcp");
    assert.equal(catalog.activeSequenceId, "final-cut:sequence:canonical-mcp");
    assert.equal(catalog.provenance.catalog.source, "background-library");

    const project = await client.callTool({ name: "project.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:canonical-mcp", sequenceId: "final-cut:sequence:canonical-mcp" },
    } });
    assert.equal(project.isError, undefined);
    const inspected = JSON.parse(textFrom(project));
    assert.equal(inspected.projectId, "final-cut:project:canonical-mcp");
    assert.equal(inspected.timeline.id, "final-cut:sequence:canonical-mcp");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("confirmed headed project inspection exports one canonical snapshot", async () => {
  const calls: string[] = [];
  let snapshotReads = 0;
  const runtime = createRuntime(calls, async () => {
    snapshotReads += 1;
    return snapshot("Original");
  });
  const { client, server } = await connect(runtime);

  try {
    const project = await client.callTool({
      name: "project.inspect",
      arguments: {
        confirmHeadedRead: true,
        expectedTarget: {
          projectId: "final-cut:project:canonical-mcp",
          sequenceId: "final-cut:sequence:canonical-mcp",
        },
      },
    });

    assert.equal(project.isError, undefined);
    assert.equal(JSON.parse(textFrom(project)).projectId, "final-cut:project:canonical-mcp");
    assert.equal(snapshotReads, 1);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical native provider disables preview transactions without canonical-live readiness", async () => {
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls));

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.compositeTransactions, false);
    assert.equal(editor.capabilities.families.editing.compositeTransactions.available, false);
    const project = await client.callTool({ name: "project.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:canonical-mcp", sequenceId: "final-cut:sequence:canonical-mcp" },
    } });
    assert.equal(project.isError, undefined);
    const inspected = JSON.parse(textFrom(project));
    assert.equal(inspected.projectId, "final-cut:project:canonical-mcp");
    assert.equal(inspected.timeline.id, "final-cut:sequence:canonical-mcp");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP fails closed when canonical Export XML snapshot is unavailable", async () => {
  const calls: string[] = [];
  const runtime = createRuntime(calls, async () => {
    throw new Error("FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear");
  });
  const { client, server } = await connect(runtime);

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "metadata-only");
    assert.equal(editor.capabilities.editor.projectRead, false);
    assert.equal(editor.capabilities.editor.timelineSnapshotRead, false);
    assert.equal(editor.capabilities.editor.timelineWrite, false);
    assert.equal(editor.capabilities.families.canonicalDocument.read.available, false);
    assert.match(
      editor.capabilities.families.canonicalDocument.read.unavailableReason,
      /canonical snapshot availability was not checked/,
    );

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(route.status, "unavailable");
    assert.equal(route.selectedPath, "none");
    assert.ok(route.missingCapabilities.includes("editor.timelineSnapshotRead"));
    assert.ok(route.missingCapabilities.includes("editor.timelineWrite|editor.timelineArtifactWrite"));

    const project = await client.callTool({ name: "project.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:canonical-mcp", sequenceId: "final-cut:sequence:canonical-mcp" },
    } });
    assert.equal(project.isError, true);
    assert.deepEqual(JSON.parse(textFrom(project)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "project.inspect requires canonicalDocument.read",
      operation: "project.inspect",
      capability: "canonicalDocument.read",
      available: false,
      backend: "final-cut-native-canonical",
      guarantee: "none",
      unavailableReason: "canonical snapshot provider unavailable: FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear",
    });

    const edit = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: "final-cut:project:canonical-mcp",
        sequenceId: "final-cut:sequence:canonical-mcp",
        baseRevision: { id: "unavailable", sequence: 0, timestamp: new Date(0).toISOString() },
        type: "rename-clip",
        clipId: "final-cut:occurrence:clip-1",
        name: "Must not mutate",
      },
    });
    assert.equal(edit.isError, true);
    assert.match(textFrom(edit), /CAPABILITY_UNAVAILABLE/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("confirmed headed context inspection fails when the canonical snapshot probe is unavailable", async () => {
  const calls: string[] = [];
  const runtime = createRuntime(calls, async () => {
    throw new Error("FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear");
  });
  const { client, server } = await connect(runtime);

  try {
    const context = await client.callTool({
      name: "context.inspect",
      arguments: {
        confirmHeadedRead: true,
        expectedTarget: {
          projectId: "final-cut:project:canonical-mcp",
          sequenceId: "final-cut:sequence:canonical-mcp",
        },
      },
    });

    assert.equal(context.isError, true);
    assert.deepEqual(JSON.parse(textFrom(context)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "CAPABILITY_UNAVAILABLE: headed canonical context could not be read",
    });
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an in-flight direct native edit excludes a canonical checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-race-"));
  const path = join(directory, "pending.json");
  const directGuard = new FileCanonicalRecoveryGuard(path);
  const canonicalGuard = new FileCanonicalRecoveryGuard(path);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const nativeEditor = {
    capabilities: () => ({}),
    edit: async () => {
      entered();
      await held;
      return { operationId: "native-edit", verification: { verified: true } };
    },
  } as unknown as NativeFinalCutEditor;
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: directGuard, nativeEditor });
  const request = client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
  try {
    await started;
    await assert.rejects(
      canonicalGuard.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }),
      /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/,
    );
  } finally {
    finish();
    await request;
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery inspection reports a native reservation without inventing a target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-native-inspect-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const reservation = await guard.beginNative("editor.native.edit");
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard });
  try {
    const inspected = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(inspected.isError ?? false, false, textFrom(inspected));
    const evidence = JSON.parse(textFrom(inspected));
    assert.equal(evidence.status, "recovery-required");
    assert.equal(evidence.nativeReservation.operation, "editor.native.edit");
    assert.match(evidence.nativeReservation.reservationId, /^[a-f0-9]{64}$/);
    assert.equal(evidence.checkpoint, undefined);
    const preview = await client.callTool({ name: "editor.native.recovery.preview", arguments: { confirmHeadedRead: true, expectedTarget: { projectId: "project-1", sequenceId: "sequence-1" }, expectedCheckpointId: evidence.nativeReservation.reservationId } });
    assert.equal(preview.isError, true);
    assert.match(textFrom(preview), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await guard.assertClear().then(() => assert.fail("reservation must remain"), () => {});
  } finally {
    await reservation.release();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain direct native outcomes retain their reservation", async () => {
  for (const outcome of ["error", "unverified"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-direct-uncertain-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
    const nativeEditor = {
      capabilities: () => ({}),
      edit: async () => {
        if (outcome === "error") throw new Error("native dispatch outcome unknown");
        return { operationId: "native-edit", verification: { verified: false } };
      },
    } as unknown as NativeFinalCutEditor;
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
    try {
      await client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
      const reservation = await guard.inspectNativeReservation();
      assert.equal(reservation?.operation, "native.edit", outcome);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a tracker that defers native search cannot release its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-deferred-search-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let deferred: (() => Promise<unknown>) | undefined;
  let searches = 0;
  const nativeEditor = {
    capabilities: () => ({}),
    trackNativeDispatch: async (invoke: () => Promise<unknown>) => { deferred = invoke; return []; },
    searchMedia: async () => { searches++; return []; },
  } as unknown as NativeFinalCutEditor;
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    await client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.ok(deferred);
    assert.equal(searches, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await deferred();
    assert.equal(searches, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a trackerless provider that defers native search retains its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-deferred-provider-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let resume!: () => void;
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  let searches = 0;
  const nativeEditor = {
    capabilities: () => ({}),
    searchMedia: async () => { void gate.then(() => { searches++; complete(); }); return []; },
  } as unknown as NativeFinalCutEditor;
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    await client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.equal(searches, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    resume();
    await completed;
    assert.equal(searches, 1);
  } finally {
    resume();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an overridden built-in search cannot release a deferred reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-override-search-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let resume!: () => void;
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  let searches = 0;
  const nativeEditor = new FinalCutNativeAutomationAdapter({ enabled: true });
  nativeEditor.searchMedia = async () => { void gate.then(() => { searches++; complete(); }); return []; };
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    await client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.equal(searches, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    resume();
    await completed;
    assert.equal(searches, 1);
  } finally {
    resume();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an overridden built-in search dependency cannot release a deferred reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-override-dependency-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let resume!: () => void;
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  let searches = 0;
  const nativeEditor = new FinalCutNativeAutomationAdapter({ enabled: true });
  (nativeEditor as unknown as { searchMediaNative: () => Promise<unknown[]> }).searchMediaNative = async () => {
    void gate.then(() => { searches++; complete(); });
    return [];
  };
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    await client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.equal(searches, 0);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    resume();
    await completed;
    assert.equal(searches, 1);
  } finally {
    resume();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a direct edit rejected before native dispatch releases its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-direct-validation-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let reservations = 0;
  const beginNative = guard.beginNative.bind(guard);
  guard.beginNative = async (operation) => { reservations += 1; return beginNative(operation); };
  const nativeEditor = new FinalCutNativeAutomationAdapter({ enabled: false });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const result = await client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
    assert.equal(result.isError, true);
    assert.equal(reservations, 1);
    await guard.assertClear();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a direct adapter failure after native dispatch retains its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-direct-dispatch-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let dispatches = 0;
  const nativeEditor = new FinalCutNativeAutomationAdapter({
    enabled: true,
    nativePreflightTimeoutMs: 20,
    executor: async () => { dispatches += 1; throw new Error("simulated native dispatch failure"); },
  });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const result = await client.callTool({ name: "editor.native.edit", arguments: { type: "add-marker-at-playhead", name: "Review" } });
    assert.equal(result.isError, true);
    assert.ok(dispatches > 0);
    assert.equal((await guard.inspectNativeReservation())?.operation, "native.edit");
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an in-flight direct native undo excludes a canonical checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-undo-race-"));
  const path = join(directory, "pending.json");
  const directGuard = new FileCanonicalRecoveryGuard(path);
  const canonicalGuard = new FileCanonicalRecoveryGuard(path);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const nativeEditor = {
    capabilities: () => ({}),
    undo: async () => { entered(); await held; return { undone: true, verification: { verified: true } }; },
  } as unknown as NativeFinalCutEditor;
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: directGuard, nativeEditor });
  const request = client.callTool({ name: "editor.native.undo", arguments: { operationId: "native-edit" } });
  try {
    await started;
    await assert.rejects(canonicalGuard.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "undo" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    finish();
    await request;
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct disposable execute and undo retain uncertain reservations", async () => {
  for (const operation of ["execute", "undo"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-disposable-route-race-"));
    const path = join(directory, "pending.json");
    const guard = new FileCanonicalRecoveryGuard(path);
    const other = new FileCanonicalRecoveryGuard(path);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const workflow = {
      preview: async () => ({}),
      [operation]: async () => {
        entered();
        await held;
        return operation === "execute"
          ? { status: "VERIFIED", verification: { passed: true } }
          : { undone: true, beforeDigest: "a".repeat(64), restoredDigest: "a".repeat(64), verification: { passed: true } };
      },
    } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["disposableNative"];
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, disposableNative: workflow });
    const request = client.callTool({ name: `editor.native.disposable.${operation}`, arguments: operation === "execute" ? { previewToken: "token" } : { operationId: "operation-1" } });
    try {
      await started;
      await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      finish();
      const result = await request;
      assert.equal(result.isError ?? false, false, textFrom(result));
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("disposable routes retain uncertain outcomes from untrusted trackers", async () => {
  for (const scenario of ["invalid-restore", "failed-after-dispatch", "failed-before-dispatch"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-disposable-uncertain-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
    const workflow = {
      trackNativeDispatch: async (call: () => Promise<unknown>, onDispatch: () => void) => {
        if (scenario === "failed-after-dispatch") onDispatch();
        return call();
      },
      undo: async () => {
        if (scenario !== "invalid-restore") throw new Error("simulated failure");
        return { undone: true, beforeDigest: "a".repeat(64), restoredDigest: "b".repeat(64), verification: { passed: true } };
      },
    } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["disposableNative"];
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, disposableNative: workflow });
    try {
      await client.callTool({ name: "editor.native.disposable.undo", arguments: { operationId: "operation-1" } });
      assert.equal((await guard.inspectNativeReservation())?.operation, "native.disposable.undo", scenario);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("trackerless native timeline commands retain their reservation", async () => {
  const commands = [
    ["editor.native.blade.execute", "executeBlade"],
    ["editor.native.mask.execute", "executeMask"],
    ["editor.native.title.add.execute", "executeTitleAdd"],
    ["editor.native.transition.add.execute", "executeTransitionAdd"],
    ["editor.native.media.append.execute", "executeAppendMedia"],
    ["editor.native.media.append.selected.execute", "executeAppendSelectedMedia"],
    ["editor.native.media.insert.execute", "executeInsertMedia"],
    ["editor.native.delete-range.execute", "executeDeleteRange"],
    ["editor.native.trim-to-duration.execute", "executeTrimToDuration"],
  ] as const;
  for (const [tool, method] of commands) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-command-reservation-"));
    const path = join(directory, "pending.json");
    const guard = new FileCanonicalRecoveryGuard(path);
    const other = new FileCanonicalRecoveryGuard(path);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const nativeEditor = { capabilities: () => ({}), [method]: async () => { entered(); await held; return { verification: { verified: true } }; } } as unknown as NativeFinalCutEditor;
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
    const request = client.callTool({ name: tool, arguments: { previewToken: "token" } });
    try {
      await started;
      await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/, tool);
      finish();
      assert.equal((await request).isError ?? false, false, tool);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("trackerless native media imports retain their reservation", async () => {
  for (const scenario of ["single", "directory", "partial", "mismatched"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-import-reservation-"));
    const path = join(directory, "pending.json");
    const guard = new FileCanonicalRecoveryGuard(path);
    const other = new FileCanonicalRecoveryGuard(path);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const media = { mediaHandle: "media-1", sourcePath: "/fixture/video.mov", verification: { verified: true, stage: "post-import-browser-discovery" } };
    const nativeEditor = {
      capabilities: () => ({}),
      importMedia: async () => { entered(); await held; return media; },
      executeImportMediaDirectory: async () => {
        entered(); await held;
        return scenario === "partial"
          ? { status: "partial", partial: true, importedCount: 1, failedCount: 1, files: [{ sourcePath: "/fixture/video.mov" }, { sourcePath: "/fixture/second.mov" }], results: [{ status: "imported", sourcePath: "/fixture/video.mov", media }, { status: "failed", sourcePath: "/fixture/second.mov" }] }
          : { status: "completed", partial: false, importedCount: 1, failedCount: 0, files: [{ sourcePath: "/fixture/video.mov" }], results: [{ status: "imported", sourcePath: scenario === "mismatched" ? "/fixture/other.mov" : "/fixture/video.mov", media }] };
      },
    } as unknown as NativeFinalCutEditor;
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
    const request = scenario === "single"
      ? client.callTool({ name: "editor.native.media.import", arguments: { path: "/fixture/video.mov" } })
      : client.callTool({ name: "editor.native.media.directory.execute", arguments: { previewToken: "token", confirm: true } });
    try {
      await started;
      await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/, scenario);
      finish();
      assert.equal((await request).isError ?? false, false, scenario);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publish reservation excludes edits and permits verification of only the same settled job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-reservation-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let state = "awaiting-confirmation";
  let dispatches = 0;
  let verifications = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: (id: string) => ({ jobId: id, state: id === "publish-job-1" ? state : "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/target.fcpbundle" }),
    executePublishJob: async (_id: string, _confirm: boolean, verify?: boolean) => {
      if (verify) { verifications += 1; state = "verified"; return { jobId: "publish-job-1", state }; }
      dispatches += 1;
      state = "verification-pending";
      entered();
      await held;
      return { jobId: "publish-job-1", state };
    },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  const dispatch = client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
  try {
    await started;
    const durable = JSON.parse(await readFile(path, "utf8"));
    assert.equal(durable.version, 3);
    assert.equal(durable.recoveryContext.jobId, "publish-job-1");
    assert.equal(durable.recoveryContext.artifactDigest, "a".repeat(64));
    assert.equal(durable.recoveryContext.requestedTarget.libraryPath, "/tmp/target.fcpbundle");
    await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const premature = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true, confirmVerification: true } });
    assert.equal(premature.isError, true);
    assert.equal(verifications, 0);
    finish();
    const pending = await dispatch;
    assert.equal(pending.isError ?? false, false);
    assert.equal(JSON.parse(textFrom(pending)).recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const otherJob = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-2", confirm: true } });
    assert.equal(otherJob.isError, true);
    const restarted = await connect(createRuntime([]), { canonicalRecovery: other, projectPublisher });
    try {
      const unowned = await restarted.client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true, confirmVerification: true } });
      assert.equal(unowned.isError, true);
      assert.equal(verifications, 0);
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }
    const verified = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true, confirmVerification: true } });
    assert.equal(verified.isError ?? false, false, textFrom(verified));
    assert.equal(JSON.parse(textFrom(verified)).recoveryReservation.reason, "native-quiescence-unproven");
    assert.equal(dispatches, 1);
    assert.equal(verifications, 1);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    finish();
    await dispatch;
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invoked publisher without dispatch acknowledgement retains its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-validation-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state: "awaiting-confirmation" }),
    trackNativeDispatch: async (call: () => Promise<unknown>) => call(),
    executePublishJob: async () => ({ state: "awaiting-final-cut" }),
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(result.isError ?? false, false, textFrom(result));
    assert.equal(JSON.parse(textFrom(result)).recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an untrusted publish tracker failure retains its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-tracker-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let boundaryBeforeTracker: string | undefined;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state: "awaiting-confirmation" }),
    trackNativeDispatch: async () => {
      boundaryBeforeTracker = (await guard.inspectNativeRecoveryEvidence()).boundaryEvidence;
      throw new Error("TRACKER_FAILED");
    },
    executePublishJob: async () => { throw new Error("not invoked"); },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(boundaryBeforeTracker, "dispatch-possible-recorded");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a publish boundary failure does not call the tracker or release the reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-boundary-failure-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const begin = guard.beginNative.bind(guard);
  guard.beginNative = async (...args) => {
    const reservation = await begin(...args);
    await mkdir(`${path}.dispatch-${reservation.reservationId}`);
    return reservation;
  };
  let trackerCalls = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state: "awaiting-confirmation" }),
    trackNativeDispatch: async () => { trackerCalls++; throw new Error("must not invoke"); },
    executePublishJob: async () => { throw new Error("must not invoke"); },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(trackerCalls, 0);
    await assert.rejects(new FileCanonicalRecoveryGuard(path).assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled built-in publisher returns a safe pre-dispatch retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-disabled-publish-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="source-project" name="Project"><sequence uid="source-sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:run", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const response = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } });
    const result = JSON.parse(textFrom(response));
    assert.equal(result.state, "awaiting-final-cut");
    assert.equal(result.nextAction, "retry");
    assert.equal(result.recoveryReservation, undefined);
    await guard.assertClear();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("built-in publisher rejects a changed artifact before dispatch without retaining reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-changed-preflight-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ enabled: true, sourcePath: artifactPath,
    liveState: async () => { throw new Error("must not contact Final Cut"); },
    readCanonicalSnapshot: async () => { throw new Error("must not read Final Cut"); } });
  const job = await publisher.preparePublish({ sourceTransactionId: "txn-preflight", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex") });
  await writeFile(artifactPath, `${source}\nchanged`);
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(result.error.code, "PUBLISH_SOURCE_CHANGED");
    assert.equal(result.recoveryReservation, undefined);
    assert.equal(publisher.getPublishJob(job.jobId).state, "failed");
    await guard.assertClear();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a changed symlinked publish source remains uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-symlink-preflight-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  const replacement = join(directory, "replacement.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ enabled: true, sourcePath: artifactPath,
    liveState: async () => { throw new Error("must not contact Final Cut"); },
    readCanonicalSnapshot: async () => { throw new Error("must not read Final Cut"); } });
  const job = await publisher.preparePublish({ sourceTransactionId: "txn-symlink", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex") });
  await writeFile(replacement, `${source}\nchanged`);
  await rm(artifactPath);
  await symlink(replacement, artifactPath);
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(result.error.code, "PUBLISH_SOURCE_CHANGED");
    assert.equal(result.recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher configuration is rechecked after reservation acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-preflight-race-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:race", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const begin = guard.beginNative.bind(guard);
  guard.beginNative = async (...args) => {
    const reservation = await begin(...args);
    (publisher as unknown as { enabled: boolean }).enabled = true;
    return reservation;
  };
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(result.recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an overridden publisher preflight dependency is treated as uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-custom-publish-preflight-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:custom", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  let calls = 0;
  (publisher as unknown as { persistPublishJob: () => void }).persistPublishJob = () => { calls++; };
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(calls, 1);
    assert.equal(result.recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom publisher job-store methods cannot establish non-dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-custom-publish-store-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:custom-store", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  const store = (publisher as unknown as { publishJobs: Map<string, unknown> }).publishJobs;
  let writes = 0;
  store.set = (key, value) => { writes++; return Map.prototype.set.call(store, key, value); };
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(writes, 1);
    assert.equal(result.recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replaced publisher prototype method cannot establish non-dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-custom-publish-prototype-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:prototype", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  const original = FinalCutProjectPublisher.prototype.executePublishJob;
  FinalCutProjectPublisher.prototype.executePublishJob = async () => ({ ...job, state: "awaiting-final-cut", nextAction: "retry" });
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(result.recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    FinalCutProjectPublisher.prototype.executePublishJob = original;
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish verification rejects a replaced reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-replaced-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  let state = "awaiting-confirmation";
  let verifications = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state }),
    executePublishJob: async (_id: string, _confirm: boolean, verify?: boolean) => {
      if (verify) verifications += 1;
      state = "verification-pending";
      return { state };
    },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const dispatched = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(dispatched.isError ?? false, false, textFrom(dispatched));
    await rm(path);
    const replacement = await other.beginNative("native.publish.replacement");
    const verification = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true, confirmVerification: true } });
    assert.equal(verification.isError, true);
    assert.equal(verifications, 0);
    assert.equal((await other.inspectNativeReservation())?.reservationId, replacement.reservationId);
    await replacement.release();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native target preparation routes exclude concurrent canonical edits", async () => {
  const cases = [
    { tool: "editor.native.focus", method: "focusTimeline", args: {}, result: { available: true } },
    { tool: "editor.native.media.select", method: "selectMedia", args: { mediaHandle: "media-1" }, result: { available: true } },
    { tool: "editor.native.media.search", method: "searchMedia", args: { query: "clip.mov" }, result: [] },
    { tool: "editor.native.timeline.locate", method: "locateOccurrence", args: { mediaHandle: "media-1" }, result: { status: "none", occurrences: [] } },
    { tool: "editor.native.blade.preview", method: "previewBlade", args: { occurrenceHandle: "occurrence-1" }, result: { previewToken: "preview-1" } },
    { tool: "editor.native.disposable.preview", method: "preview", args: { clipId: "clip-1", name: "Renamed" }, result: { previewToken: "preview-1" }, disposable: true },
  ];
  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-native-preparation-"));
    const path = join(directory, "pending.json");
    const guard = new FileCanonicalRecoveryGuard(path);
    const other = new FileCanonicalRecoveryGuard(path);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const provider = { capabilities: () => ({}), [item.method]: async () => { entered(); await held; return item.result; } };
    const options = item.disposable
      ? { canonicalRecovery: guard, disposableNative: provider as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["disposableNative"] }
      : { canonicalRecovery: guard, nativeEditor: provider as unknown as NativeFinalCutEditor };
    const { client, server } = await connect(createRuntime([]), options);
    const request = client.callTool({ name: item.tool, arguments: item.args });
    try {
      await started;
      await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "a".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/, item.tool);
      finish();
      assert.equal((await request).isError ?? false, false, item.tool);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("uncertain native preparation keeps its reservation", async () => {
  for (const outcome of ["error", "invalid-preview"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-native-preparation-failure-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
    const nativeEditor = {
      capabilities: () => ({}),
      previewBlade: async () => {
        if (outcome === "error") throw new Error("native preparation outcome unknown");
        return {};
      },
    } as unknown as NativeFinalCutEditor;
    const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
    try {
      await client.callTool({ name: "editor.native.blade.preview", arguments: { occurrenceHandle: "clip-1" } });
      assert.equal((await guard.inspectNativeReservation())?.operation, "native.previewblade", outcome);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("native preparation unavailable through an untrusted tracker retains its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-preparation-unavailable-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const nativeEditor = {
    capabilities: () => ({}),
    trackNativeDispatch: async (operation: () => Promise<unknown>) => operation(),
    focusTimeline: async () => ({ available: false, error: { code: "CAPABILITY_UNAVAILABLE" } }),
  } as unknown as NativeFinalCutEditor;
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const result = await client.callTool({ name: "editor.native.focus", arguments: {} });
    assert.equal(result.isError ?? false, false);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP native recovery evidence exposes only read-only unproven sender observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-readonly-evidence-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls, async () => { throw new Error("unexpected canonical read"); }), { canonicalRecovery: guard });
  try {
    const record = JSON.stringify({ version: 2, kind: "native-operation", owner: "00000000-0000-4000-8000-000000000001", operation: "native.searchmedia" }) + "\n";
    await writeFile(path, record);
    const response = await client.callTool({ name: "editor.native.recovery.evidence.inspect", arguments: {} });
    const value = JSON.parse(textFrom(response));
    assert.equal(value.status, "recovery-required");
    assert.equal(value.reservation.version, 2);
    assert.equal(value.reservation.operation, "native.searchmedia");
    assert.equal(value.sender.status, "untracked");
    assert.equal(value.recoveryEligibility, "unavailable");
    assert.equal(value.nativeQuiescence, "unproven");
    assert.equal(await readFile(path, "utf8"), record);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutable publisher persistence dependency cannot prove non-dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-custom-publish-persistence-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ headlessSourceVerifier: async () => ({ targetLibraryUid: "library", sourceMediaDigests: [] }) });
  const job = await publisher.preparePublish({ sourceTransactionId: "headless-rough-cut:mutable-persistence", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex"), targetLibraryPath: join(directory, "New.fcpbundle") });
  let arbitraryDependencyCalls = 0;
  Object.defineProperty(publisher, "publishJobsDirectory", { configurable: true, get() { arbitraryDependencyCalls++; return undefined; } });
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    const result = JSON.parse(textFrom(await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } })));
    assert.equal(arbitraryDependencyCalls, 1);
    assert.equal(result.recoveryReservation?.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutable runtime persistence data cannot prove non-dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-custom-publish-runtime-"));
  const source = '<fcpxml version="1.11"><library><event><project uid="project" name="Project"><sequence uid="sequence" name="Main" /></project></event></library></fcpxml>';
  const artifactPath = join(directory, "source.fcpxml");
  await writeFile(artifactPath, source);
  const publisher = new FinalCutProjectPublisher({ enabled: true, sourcePath: artifactPath, publishJobsDirectory: join(directory, "jobs"),
    liveState: async () => { throw new Error("must not contact Final Cut"); },
    readCanonicalSnapshot: async () => { throw new Error("must not read Final Cut"); } });
  const job = await publisher.preparePublish({ sourceTransactionId: "txn-preflight", artifactPath,
    artifactDigest: createHash("sha256").update(source).digest("hex") });
  await writeFile(artifactPath, `${source}\nchanged`);
  let arbitraryDependencyCalls = 0;
  const runtime = { get arbitrary() { arbitraryDependencyCalls++; return "observed"; } };
  (publisher as unknown as { publishJobRuntime: Map<string, unknown> }).publishJobRuntime.set(job.jobId, runtime);
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher: publisher });
  try {
    await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: job.jobId, confirm: true } });
    assert.equal(arbitraryDependencyCalls, 1);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("untrusted publish job lookup cannot run while a native reservation is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-untrusted-publish-lookup-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const reservation = await guard.beginNative("native.existing");
  let lookups = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => { lookups++; return { state: "awaiting-confirmation" }; },
    executePublishJob: async () => { throw new Error("must not execute"); },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(lookups, 0);
  } finally {
    await client.close();
    await server.close();
    await reservation.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish execute getter cannot run while another reservation is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-execute-getter-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const reservation = await guard.beginNative("native.existing");
  let lookups = 0;
  const publisher = { isAvailable: () => false, getPublishJob: () => ({ state: "awaiting-confirmation" }) };
  Object.defineProperty(publisher, "executePublishJob", { get() { lookups++; return async () => ({}); } });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard,
    projectPublisher: publisher as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"] });
  try {
    lookups = 0;
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(lookups, 0);
  } finally {
    await client.close();
    await server.close();
    await reservation.release();
    await rm(directory, { recursive: true, force: true });
  }
});


test("custom publish lookup runs after durable uncertainty and binds intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-bound-lookup-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  let lookups = 0;
  let markerObserved = false;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => {
      lookups++;
      const contents = readFileSync(path, "utf8");
      const id = createHash("sha256").update(contents).digest("hex");
      markerObserved = existsSync(`${path}.dispatch-${id}`);
      return { state: "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/target.fcpbundle" };
    },
    executePublishJob: async () => ({ state: "verification-pending" }),
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
    assert.equal(lookups, 1);
    assert.equal(markerObserved, true);
    const observed = await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence();
    assert.equal(observed.reservation?.version, 3);
    assert.equal(observed.reservation?.jobId, "publish-job-1");
    assert.equal(observed.intent?.artifactDigest, "a".repeat(64));
    assert.equal(observed.boundaryEvidence, "dispatch-possible-recorded");
    await assert.rejects(guard.assertClear(), /RECOVERY_REQUIRED/);
  } finally {
    await client.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("failed publish intent binding blocks provider execution and retains reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-bind-failure-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const begin = guard.beginNative.bind(guard);
  guard.beginNative = async (...args) => {
    const reservation = await begin(...args);
    reservation.bindRecoveryContext = async () => { throw new Error("binding failed"); };
    return reservation;
  };
  let calls = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ state: "awaiting-confirmation", artifactDigest: "a".repeat(64), targetLibraryPath: "/tmp/target.fcpbundle" }),
    executePublishJob: async () => { calls++; return { state: "verification-pending" }; },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    const observed = await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence();
    assert.equal(observed.reservation?.version, 2);
    assert.equal(observed.boundaryEvidence, "dispatch-possible-recorded");
    await assert.rejects(guard.assertClear(), /RECOVERY_REQUIRED/);
  } finally {
    await client.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("a throwing custom publish lookup retains the uncertain reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-lookup-failure-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  let calls = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => { throw new Error("lookup failed"); },
    executePublishJob: async () => { calls++; return { state: "verification-pending" }; },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const result = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    const observed = await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence();
    assert.equal(observed.reservation?.version, 2);
    assert.equal(observed.boundaryEvidence, "dispatch-possible-recorded");
    assert.equal(observed.recoveryEligibility, "unavailable");
    await assert.rejects(guard.assertClear(), /RECOVERY_REQUIRED/);
  } finally {
    await client.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});
