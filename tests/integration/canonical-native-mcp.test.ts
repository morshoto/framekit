import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { NativeRecoveryEvidenceSource } from "../../apps/mcp-server/src/native-recovery-verification.js";
import {
  FinalCutCanonicalNativeProvider,
  FinalCutNativeAutomationAdapter,
  FileCanonicalRecoveryGuard,
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
    await mkdir(`${path}.lock`);
    const inTransaction = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(inTransaction.isError, true);
    assert.match(textFrom(inTransaction), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await rm(`${path}.lock`, { recursive: true });
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
    assert.deepEqual(evidence.nativeExecution, { status: "unknown", nativeQuiescence: "unproven" });
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

test("a direct edit rejected before native dispatch releases its reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-direct-validation-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let reservations = 0;
  const beginNative = guard.beginNative.bind(guard);
  guard.beginNative = async (...args) => { reservations += 1; return beginNative(...args); };
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
    const reservation = await guard.inspectNativeReservation();
    assert.equal(reservation?.operation, "native.edit");
    assert.equal(nativeEditor.nativeExecutionStatus(reservation!.reservationId), "executor-settled");
    const inspected = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    const evidence = JSON.parse(textFrom(inspected));
    assert.deepEqual(evidence.nativeExecution, { status: "executor-settled", nativeQuiescence: "unproven" });
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("timed out native search retains sender activity until its executor settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-search-sender-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  let finish!: (value: string) => void;
  const execution = new Promise<string>((resolve) => { finish = resolve; });
  const nativeEditor = new FinalCutNativeAutomationAdapter({ enabled: true, nativePreflightTimeoutMs: 30, executor: async () => execution });
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const result = await client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.equal(result.isError, true);
    const reservation = await guard.inspectNativeReservation();
    assert.equal(reservation?.operation, "native.searchmedia");
    assert.equal(nativeEditor.nativeExecutionStatus(reservation!.reservationId), "abort-requested");
    assert.ok((await lstat(`${path}.active`)).isFile());
    finish("");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await lstat(`${path}.active`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await assert.rejects(lstat(`${path}.active`), { code: "ENOENT" });
    assert.equal((await guard.inspectNativeReservation())?.reservationId, reservation!.reservationId);
  } finally { finish(""); await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("uncertain native search remains reserved after restart and cannot be replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-search-recovery-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  let dispatches = 0;
  let notifyDispatch: (() => void) | undefined;
  const nativeEditor = {
    capabilities: () => ({}),
    trackNativeDispatch: async (operation: () => Promise<unknown>, onDispatch: () => void) => {
      notifyDispatch = onDispatch;
      try { return await operation(); } finally { notifyDispatch = undefined; }
    },
    searchMedia: async () => {
      dispatches += 1;
      notifyDispatch?.();
      throw new Error("FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT: outcome unknown");
    },
  } as unknown as NativeFinalCutEditor;
  const first = await connect(createRuntime([]), { canonicalRecovery: guard, nativeEditor });
  try {
    const result = await first.client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
    assert.equal(result.isError, true);
    const reservation = await guard.inspectNativeReservation();
    assert.equal(reservation?.operation, "native.searchmedia");
    assert.equal(dispatches, 1);
    await first.client.close();
    await first.server.close();
    const restartedGuard = new FileCanonicalRecoveryGuard(path);
    const restarted = await connect(createRuntime([]), { canonicalRecovery: restartedGuard, nativeEditor });
    try {
      const retry = await restarted.client.callTool({ name: "editor.native.media.search", arguments: { query: "clip.mov" } });
      assert.equal(retry.isError, true);
      assert.equal(dispatches, 1);
      assert.deepEqual(await restartedGuard.inspectNativeReservation(), reservation);
      await assert.rejects(restartedGuard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally { await restarted.client.close(); await restarted.server.close(); }
  } finally { await first.client.close().catch(() => {}); await first.server.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test("an owner process exit leaves an uncertain search reserved for a new MCP process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-search-process-recovery-"));
  const path = join(directory, "canonical-recovery", "pending.json");
  const owner = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";
    await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative("native.searchmedia");
    process.exit(17);
  `, path], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(owner.status, 17, owner.stderr);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "apps/mcp-server/src/main.ts")],
    env: finalCutMcpEnvironment({
      FRAMEKIT_STATE_DIR: directory, FRAMEKIT_FINAL_CUT_HEADLESS: "1", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
      FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "", FRAMEKIT_FINAL_CUT_CANONICAL_REQUIRED: "", FRAMEKIT_FCPXML_PATH: "",
      FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "search-owner-exit-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "editor.native.recovery.inspect", arguments: {} });
    assert.equal(response.isError ?? false, false);
    const evidence = JSON.parse(textFrom(response));
    assert.equal(evidence.status, "recovery-required");
    assert.equal(evidence.nativeReservation.operation, "native.searchmedia");
    assert.match(evidence.nativeReservation.reservationId, /^[a-f0-9]{64}$/);
    await assert.rejects(new FileCanonicalRecoveryGuard(path).assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally { await client.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); }
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

test("direct disposable execute and undo exclude canonical checkpoints", async () => {
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
      await guard.assertClear();
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("disposable routes retain unverified outcomes but release pre-dispatch failures", async () => {
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
      if (scenario === "failed-before-dispatch") await guard.assertClear();
      else assert.equal((await guard.inspectNativeReservation())?.operation, "native.disposable.undo", scenario);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("native timeline command routes hold the shared checkpoint until verification", async () => {
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
      await guard.assertClear();
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("native media imports reserve until verified and retain partial outcomes", async () => {
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
      if (scenario === "partial" || scenario === "mismatched") assert.equal((await guard.inspectNativeReservation())?.operation, "native.executeimportmediadirectory");
      else await guard.assertClear();
    } finally {
      finish();
      await request;
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publish reserves its requested target and dispatch identity across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-publish-recovery-context-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const jobId = "publish-job-123";
  const requestedLibraryPath = join(directory, "new.fcpbundle");
  const artifactDigest = "a".repeat(64);
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: () => ({ jobId, state: "awaiting-confirmation", targetLibraryPath: requestedLibraryPath, artifactDigest }),
    executePublishJob: async () => ({ jobId, state: "verification-pending" }),
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  try {
    const response = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId, confirm: true } });
    assert.equal(response.isError ?? false, false);
    const result = JSON.parse(textFrom(response));
    const afterRestart = await new FileCanonicalRecoveryGuard(path).inspectNativeReservation();
    assert.equal(afterRestart?.reservationId, result.recoveryReservation.reservationId);
    assert.equal(afterRestart?.recoveryContext?.kind, "publish");
    assert.equal(afterRestart?.recoveryContext?.jobId, jobId);
    assert.match(afterRestart?.recoveryContext?.dispatchId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(result.recoveryReservation.dispatchId, afterRestart?.recoveryContext?.dispatchId);
    assert.deepEqual(afterRestart?.recoveryContext?.requestedTarget, { libraryPath: requestedLibraryPath });
    assert.equal(afterRestart?.recoveryContext?.artifactDigest, artifactDigest);
    assert.equal(afterRestart?.recoveryContext?.nativeQuiescence, "unproven");
    await assert.rejects(new FileCanonicalRecoveryGuard(path).assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
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
    getPublishJob: (id: string) => ({ jobId: id, state: id === "job-1" ? state : "awaiting-confirmation" }),
    executePublishJob: async (_id: string, _confirm: boolean, verify?: boolean) => {
      if (verify) { verifications += 1; state = "verified"; return { jobId: "job-1", state }; }
      dispatches += 1;
      state = "verification-pending";
      entered();
      await held;
      return { jobId: "job-1", state };
    },
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[1]>["projectPublisher"];
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: guard, projectPublisher });
  const dispatch = client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true } });
  try {
    await started;
    await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "b".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const premature = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true, confirmVerification: true } });
    assert.equal(premature.isError, true);
    assert.equal(verifications, 0);
    finish();
    const pending = await dispatch;
    assert.equal(pending.isError ?? false, false);
    assert.equal(JSON.parse(textFrom(pending)).recoveryReservation.reason, "native-quiescence-unproven");
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const otherJob = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-2", confirm: true } });
    assert.equal(otherJob.isError, true);
    const restarted = await connect(createRuntime([]), { canonicalRecovery: other, projectPublisher });
    try {
      const unowned = await restarted.client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true, confirmVerification: true } });
      assert.equal(unowned.isError, true);
      assert.equal(verifications, 0);
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }
    const verified = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "job-1", confirm: true, confirmVerification: true } });
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

test("publish validation before dispatch does not leave a reservation", async () => {
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
    await guard.assertClear();
  } finally {
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
      await guard.assertClear();
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

test("native preparation unavailable before dispatch releases its reservation", async () => {
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
    await guard.assertClear();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP recovery requires confirmation and trusted evidence for both routes", async () => {
  for (const kind of ["publish", "materialization"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-verified-recovery-"));
    const path = join(directory, "pending.json");
    const jobId = kind === "publish" ? "publish-job-123" : "materialization-123";
    const operation = `native.${kind === "publish" ? "publish" : "materialize"}.${createHash("sha256").update(jobId).digest("hex")}`;
    const target: Record<string, string> = kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }
      : { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" };
    const context = { kind, jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver-1",
      dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64), desiredDigest: "b".repeat(64),
      requestedTarget: kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle" } : target,
      canonicalTarget: target, expectedCanonicalDigest: "b".repeat(64) };
    const guard = new FileCanonicalRecoveryGuard(path);
    const reservation = await guard.beginNative(operation, context as never, { trackExecution: true });
    await reservation.finishExecution!();
    let reads = 0;
    let wrongTarget = false;
    const source: NativeRecoveryEvidenceSource = {
      observeReceiver: async (binding) => ({ reservationId: binding.reservationId, jobId: binding.jobId, dispatchId: binding.dispatchId,
        executorIdentity: binding.executorIdentity, state: "terminal", outcome: "completed", receiptId: "mock-receipt" }),
      readCanonical: async () => { reads++; return { target: wrongTarget ? { ...target, projectUid: "wrong" } : target, digest: context.expectedCanonicalDigest, complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }; },
    };
    const absent = await connect(createRuntime([]), { canonicalRecovery: guard });
    const ready = await connect(createRuntime([]), { canonicalRecovery: guard, nativeRecoveryEvidence: source } as never);
    try {
      const args = { expectedReservationId: reservation.reservationId, outcome: "completed", confirm: true };
      const unavailable = await absent.client.callTool({ name: "editor.native.recovery.execute", arguments: args });
      assert.equal(unavailable.isError, true);
      assert.match(textFrom(unavailable), /CAPABILITY_UNAVAILABLE/);
      const unconfirmed = await ready.client.callTool({ name: "editor.native.recovery.execute", arguments: { ...args, confirm: false } });
      assert.equal(unconfirmed.isError, true);
      assert.equal(reads, 0);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      wrongTarget = true;
      const mismatch = await ready.client.callTool({ name: "editor.native.recovery.execute", arguments: args });
      assert.equal(mismatch.isError, true);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      wrongTarget = false;
      const recovered = await ready.client.callTool({ name: "editor.native.recovery.execute", arguments: args });
      assert.equal(recovered.isError ?? false, false, textFrom(recovered));
      assert.deepEqual(JSON.parse(textFrom(recovered)), { outcome: "completed", alreadyReleased: false });
      await guard.assertClear();
      const repeated = await ready.client.callTool({ name: "editor.native.recovery.execute", arguments: args });
      assert.deepEqual(JSON.parse(textFrom(repeated)), { outcome: "completed", alreadyReleased: true });
      assert.equal(reads, 2);
    } finally {
      await absent.client.close(); await absent.server.close(); await ready.client.close(); await ready.server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("verified publish recovery permits a later publish across servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-publish-recovered-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const target = { libraryPath: join(directory, "target.fcpbundle"), projectUid: "project-1", sequenceUid: "sequence-1" };
  const recovery = {
    assertClear: guard.assertClear.bind(guard), inspectVersioned: guard.inspectVersioned.bind(guard),
    inspectNativeReservation: guard.inspectNativeReservation.bind(guard), completeVerifiedNative: guard.completeVerifiedNative.bind(guard),
    inspectCompletedNative: (id: string) => (guard as unknown as { inspectCompletedNative(id: string): Promise<boolean> }).inspectCompletedNative(id),
    beginNative: async (operation: string, context: Record<string, unknown>, options?: { trackExecution?: boolean }) => guard.beginNative(operation, {
      ...context, executorIdentity: "mock-receiver-1", dispatchState: "intent", canonicalTarget: target, expectedCanonicalDigest: "b".repeat(64),
    } as never, options),
  };
  let publishes = 0;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: (jobId: string) => ({ jobId, state: "awaiting-confirmation", targetLibraryPath: target.libraryPath, artifactDigest: "a".repeat(64) }),
    executePublishJob: async (jobId: string) => { publishes++; return { jobId, state: "verification-pending" }; },
  };
  const source: NativeRecoveryEvidenceSource = {
    observeReceiver: async (binding) => ({ reservationId: binding.reservationId, dispatchId: binding.dispatchId, jobId: binding.jobId,
      executorIdentity: binding.executorIdentity, state: "terminal", outcome: "completed", receiptId: "mock-receipt" }),
    readCanonical: async () => ({ target, digest: "b".repeat(64), complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }),
  };
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: recovery, projectPublisher, nativeRecoveryEvidence: source } as never);
  const other = await connect(createRuntime([]), { canonicalRecovery: recovery, nativeRecoveryEvidence: source } as never);
  try {
    const first = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
    assert.equal(first.isError ?? false, false, textFrom(first));
    const reservationId = JSON.parse(textFrom(first)).recoveryReservation.reservationId;
    const recovered = await other.client.callTool({ name: "editor.native.recovery.execute", arguments: { expectedReservationId: reservationId, outcome: "completed", confirm: true } });
    assert.equal(recovered.isError ?? false, false, textFrom(recovered));
    const proofPath = join(`${join(directory, "pending.json")}.completed`, `${reservationId}.proof`);
    const proof = await readFile(proofPath, "utf8");
    await writeFile(proofPath, "invalid");
    const invalid = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-2", confirm: true } });
    assert.equal(invalid.isError, true);
    assert.equal(publishes, 1);
    await writeFile(proofPath, proof);
    const second = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-2", confirm: true } });
    assert.equal(second.isError ?? false, false, textFrom(second));
    assert.equal(publishes, 2);
  } finally { await client.close(); await server.close(); await other.client.close(); await other.server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("recovery refuses an active local publisher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-mcp-publish-recovered-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const target = { libraryPath: join(directory, "target.fcpbundle"), projectUid: "project-1", sequenceUid: "sequence-1" };
  const recovery = {
    assertClear: guard.assertClear.bind(guard), inspectVersioned: guard.inspectVersioned.bind(guard),
    inspectNativeReservation: guard.inspectNativeReservation.bind(guard), completeVerifiedNative: guard.completeVerifiedNative.bind(guard),
    beginNative: async (operation: string, context: Record<string, unknown>, options?: { trackExecution?: boolean }) => guard.beginNative(operation, {
      ...context, executorIdentity: "mock-receiver-1", dispatchState: "intent", canonicalTarget: target, expectedCanonicalDigest: "b".repeat(64),
    } as never, options),
  };
  let publishes = 0;
  let started!: () => void; let finish!: () => void;
  const publishing = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let readStarted!: () => void; let finishRead!: () => void;
  const reading = new Promise<void>((resolve) => { readStarted = resolve; });
  const heldRead = new Promise<void>((resolve) => { finishRead = resolve; });
  let holdCanonical = false;
  const projectPublisher = {
    isAvailable: () => false,
    getPublishJob: (jobId: string) => ({ jobId, state: "awaiting-confirmation", targetLibraryPath: target.libraryPath, artifactDigest: "a".repeat(64) }),
    executePublishJob: async (jobId: string) => { publishes++; if (publishes === 1) { started(); await held; } return { jobId, state: "verification-pending" }; },
  };
  const source: NativeRecoveryEvidenceSource = {
    observeReceiver: async (binding) => ({ reservationId: binding.reservationId, dispatchId: binding.dispatchId, jobId: binding.jobId,
      executorIdentity: binding.executorIdentity, state: "terminal", outcome: "completed", receiptId: "mock-receipt" }),
    readCanonical: async () => { if (holdCanonical) { readStarted(); await heldRead; } return { target, digest: "b".repeat(64), complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }; },
  };
  const { client, server } = await connect(createRuntime([]), { canonicalRecovery: recovery, projectPublisher, nativeRecoveryEvidence: source } as never);
  const other = await connect(createRuntime([]), { canonicalRecovery: recovery, nativeRecoveryEvidence: source } as never);
  try {
    const pending = client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-1", confirm: true } });
    await publishing;
    const active = await guard.inspectNativeReservation();
    const premature = await client.callTool({ name: "editor.native.recovery.execute", arguments: { expectedReservationId: active!.reservationId, outcome: "completed", confirm: true } });
    const remotePremature = await other.client.callTool({ name: "editor.native.recovery.execute", arguments: { expectedReservationId: active!.reservationId, outcome: "completed", confirm: true } });
    finish();
    const first = await pending;
    assert.equal(premature.isError, true, "recovery must not release while publisher remains active");
    assert.equal(remotePremature.isError, true, "another server must not release an active publisher's reservation");
    assert.equal(first.isError ?? false, false, textFrom(first));
    const reservationId = JSON.parse(textFrom(first)).recoveryReservation.reservationId;
    holdCanonical = true;
    const recoveryPending = client.callTool({ name: "editor.native.recovery.execute", arguments: { expectedReservationId: reservationId, outcome: "completed", confirm: true } });
    await reading;
    const overlap = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-2", confirm: true } });
    assert.equal(overlap.isError, true, "publish must not start during recovery");
    assert.equal(publishes, 1);
    finishRead();
    const recovered = await recoveryPending;
    assert.equal(recovered.isError ?? false, false, textFrom(recovered));
    const second = await client.callTool({ name: "artifact.publish.execute", arguments: { jobId: "publish-job-2", confirm: true } });
    assert.equal(second.isError ?? false, false, textFrom(second));
    assert.equal(publishes, 2);
  } finally { finish(); finishRead(); await client.close(); await server.close(); await other.client.close(); await other.server.close(); await rm(directory, { recursive: true, force: true }); }
});
