import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutConnectionManager, assertCanonicalProviderConfiguration } from "@framekit/final-cut";

const capabilities = {
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
    playbackControl: false,
  },
  analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
};

const canonicalWriteCapabilities = {
  ...capabilities,
  editor: {
    ...capabilities.editor,
    timelineSnapshotRead: true,
    timelineWrite: true,
    readAfterWrite: true,
    rollback: true,
    projectCatalogRead: true,
    projectSelection: true,
  },
};

test("connection manager reports a ready live bridge without installing anything", async () => {
  const manager = new FinalCutConnectionManager({
    headless: false,
    detectFinalCut: async () => true,
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities,
    }),
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "ready");
  assert.equal(status.identity?.backend, "workflow-extension-ipc");
  assert.equal(status.capabilities?.editor.liveStateRead, true);
});

test("canonical provider requirement rejects metadata-only sockets without fallback", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    canonicalProviderRequired: true,
    headless: false,
    detectFinalCut: async () => { events.push("detect"); return true; },
    launchFinalCut: async () => { events.push("launch"); },
    installExtension: async () => { events.push("install"); },
    activateExtension: async () => { events.push("activate"); },
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities,
    }),
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "needs-user-action");
  assert.equal(status.lastError?.code, "FINAL_CUT_CANONICAL_PROVIDER_REQUIRED");
  assert.deepEqual(events, []);
});

test("canonical provider requirement rejects FCPXML fallback configuration", () => {
  assert.throws(
    () => assertCanonicalProviderConfiguration({ required: true, fcpxmlPath: "/tmp/project.fcpxml" }),
    /FINAL_CUT_CANONICAL_FALLBACK_CONFLICT/,
  );
});

test("canonical provider requirement accepts a canonical-write socket", async () => {
  const manager = new FinalCutConnectionManager({
    canonicalProviderRequired: true,
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "external-canonical-provider" },
      capabilities: canonicalWriteCapabilities,
    }),
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "ready");
  assert.equal(status.capabilities?.editor.canonicalTimelineMode, "canonical-write");
});

test("canonical provider requirement reports unavailable when no provider socket responds", async () => {
  const manager = new FinalCutConnectionManager({
    canonicalProviderRequired: true,
    detectFinalCut: async () => { throw new Error("must not detect Final Cut"); },
    probe: async () => { throw new Error("socket missing"); },
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "needs-user-action");
  assert.equal(status.lastError?.code, "FINAL_CUT_CANONICAL_PROVIDER_UNAVAILABLE");
});

test("headless connection probes an existing bridge without launching or activating Final Cut", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
    startupTimeoutMs: 30,
    pollIntervalMs: 1,
    detectFinalCut: async () => { events.push("detect"); return false; },
    launchFinalCut: async () => { events.push("launch"); },
    activateExtension: async () => { events.push("activate"); },
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities,
    }),
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "ready");
  assert.deepEqual(events, []);
});

test("headless connection waits for an existing bridge to become ready", async () => {
  let probes = 0;
  const sleeps: number[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
    startupTimeoutMs: 100,
    pollIntervalMs: 10,
    probe: async () => {
      probes += 1;
      if (probes === 1) throw new Error("socket is still starting");
      return {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities,
      };
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "ready");
  assert.equal(probes, 2);
  assert.deepEqual(sleeps, [10]);
});

test("headless connection uses one coherent socket capability response", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-headless-socket-test-"));
  const socketPath = join(directory, "bridge.sock");
  let requests = 0;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      requests += 1;
      const request = JSON.parse(String(chunk).trim()) as { id: string; version: number };
      socket.end(`${JSON.stringify({
        version: request.version,
        id: request.id,
        ok: true,
        result: {
          identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
          capabilities,
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    const manager = new FinalCutConnectionManager({
      headless: true,
      socketPath,
      startupTimeoutMs: 100,
    });
    const status = await manager.ensureConnected();

    assert.equal(status.state, "ready");
    assert.equal(status.identity?.backend, "workflow-extension-ipc");
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("headless connection fails closed when the existing bridge is unavailable", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
    startupTimeoutMs: 30,
    pollIntervalMs: 1,
    detectFinalCut: async () => { events.push("detect"); return true; },
    launchFinalCut: async () => { events.push("launch"); },
    activateExtension: async () => { events.push("activate"); },
    probe: async () => { throw new Error("socket missing"); },
    sleep: async () => {},
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError?.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
  assert.deepEqual(events, []);
});

test("headless connection reports incompatible bridge protocols", async () => {
  const manager = new FinalCutConnectionManager({
    headless: true,
    socketPath: "/tmp/framekit-incompatible.sock",
    startupTimeoutMs: 100,
    probe: async () => {
      throw new Error("FINAL_CUT_LIVE_PROTOCOL: unsupported request version");
    },
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError?.code, "FINAL_CUT_HEADLESS_PROTOCOL_INCOMPATIBLE");
  assert.match(status.lastError?.message ?? "", /unsupported request version/);
  assert.match(status.lastError?.message ?? "", /incompatible/);
});

test("headless connection reports an installed extension before socket failure", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-headless-extension-test-"));
  const extensionPath = join(directory, "FramekitFinalCutWorkflow.app");
  await mkdir(extensionPath);
  const manager = new FinalCutConnectionManager({
    headless: true,
    extensionInstallPath: extensionPath,
    startupTimeoutMs: 30,
    pollIntervalMs: 1,
    probe: async () => { throw new Error("socket missing"); },
    sleep: async () => {},
  });

  const status = await manager.ensureConnected();

  assert.equal(status.state, "unavailable");
  assert.equal(status.extensionInstalled, true);
  assert.equal(status.lastError?.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
});

test("connection manager clears stale capabilities after a ready bridge disconnects", async () => {
  let available = true;
  const manager = new FinalCutConnectionManager({
    headless: true,
    startupTimeoutMs: 30,
    pollIntervalMs: 1,
    probe: async () => {
      if (!available) throw new Error("socket missing");
      return {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities,
      };
    },
    sleep: async () => {},
  });

  const ready = await manager.ensureConnected();
  available = false;
  const disconnected = await manager.ensureConnected();

  assert.equal(ready.state, "ready");
  assert.equal(disconnected.state, "unavailable");
  assert.equal(disconnected.identity, undefined);
  assert.equal(disconnected.capabilities, undefined);
});

test("connection manager remains actionable when the extension is missing", async () => {
  const manager = new FinalCutConnectionManager({
    headless: false,
    extensionInstallPath: "/tmp/framekit-test-extension-that-does-not-exist.app",
    detectFinalCut: async () => true,
    probe: async () => { throw new Error("socket missing"); },
    installExtension: async () => {},
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "needs-user-action");
  assert.equal(status.lastError?.code, "EXTENSION_NOT_INSTALLED");
});

test("connection manager starts Final Cut and retries until the bridge is ready", async () => {
  let detected = false;
  let probes = 0;
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-connection-test-"));
  const extensionPath = join(directory, "FramekitFinalCutWorkflow.app");
  await mkdir(extensionPath);
  const manager = new FinalCutConnectionManager({
    headless: false,
    startupTimeoutMs: 1_000,
    detectFinalCut: async () => detected,
    launchFinalCut: async () => { detected = true; },
    launchExtension: async () => {},
    activateExtension: async () => {},
    installExtension: async () => {},
    extensionInstallPath: extensionPath,
    probe: async () => {
      probes += 1;
      if (probes < 2) throw new Error("socket missing");
      return {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities,
      };
    },
    sleep: async () => {},
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "ready");
  assert.equal(status.editorDetected, true);
  assert.equal(probes >= 2, true);
});

test("connection manager bounds a blocking extension activation to the startup deadline", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-activation-timeout-test-"));
  const extensionPath = join(directory, "FramekitFinalCutWorkflow.app");
  await mkdir(extensionPath);
  let activationOptions: { signal?: AbortSignal; timeoutMs?: number } | undefined;
  const manager = new FinalCutConnectionManager({
    headless: false,
    startupTimeoutMs: 30,
    extensionInstallPath: extensionPath,
    detectFinalCut: async () => true,
    probe: async () => { throw new Error("socket missing"); },
    activateExtension: async (options) => {
      activationOptions = options;
      await new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("activation aborted")), { once: true });
      });
    },
    sleep: async () => {},
  });

  const startedAt = Date.now();
  const status = await manager.ensureConnected();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError?.code, "FINAL_CUT_ACTIVATION_TIMEOUT");
  assert.ok(activationOptions?.timeoutMs !== undefined && activationOptions.timeoutMs <= 30);
  assert.equal(activationOptions?.signal?.aborted, true);
});

test("explicit connection restarts Final Cut after replacing the extension", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-restart-test-"));
  const sourcePath = join(directory, "source", "FramekitFinalCutWorkflow.app");
  const installPath = join(directory, "Applications", "FramekitFinalCutWorkflow.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });
  const events: string[] = [];

  const manager = new FinalCutConnectionManager({
    headless: false,
    extensionSourcePath: sourcePath,
    extensionInstallPath: installPath,
    restartAfterInstall: true,
    detectFinalCut: async () => true,
    installExtension: async () => { events.push("install"); },
    registerExtension: async () => { events.push("register"); },
    restartFinalCut: async () => { events.push("restart"); },
    launchExtension: async () => { events.push("launch-extension"); },
    activateExtension: async () => { events.push("activate"); },
    probe: async () => {
      if (!events.includes("restart")) throw new Error("socket missing");
      return {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities,
      };
    },
    sleep: async () => {},
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "ready");
  assert.deepEqual(events, ["install", "register", "restart", "launch-extension", "activate"]);
});

test("background connection does not restart Final Cut after extension replacement", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-no-restart-test-"));
  const sourcePath = join(directory, "source", "FramekitFinalCutWorkflow.app");
  const installPath = join(directory, "Applications", "FramekitFinalCutWorkflow.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });
  let restarted = false;

  const manager = new FinalCutConnectionManager({
    headless: false,
    extensionSourcePath: sourcePath,
    extensionInstallPath: installPath,
    detectFinalCut: async () => true,
    installExtension: async () => {},
    registerExtension: async () => {},
    restartFinalCut: async () => { restarted = true; },
    activateExtension: async () => {},
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities,
    }),
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "ready");
  assert.equal(restarted, false);
});

test("restart timeout is reported as user action", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-restart-timeout-test-"));
  const sourcePath = join(directory, "source", "FramekitFinalCutWorkflow.app");
  const installPath = join(directory, "Applications", "FramekitFinalCutWorkflow.app");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(installPath, { recursive: true });

  const manager = new FinalCutConnectionManager({
    headless: false,
    extensionSourcePath: sourcePath,
    extensionInstallPath: installPath,
    restartAfterInstall: true,
    detectFinalCut: async () => true,
    installExtension: async () => {},
    registerExtension: async () => {},
    restartFinalCut: async () => {
      throw new Error("FINAL_CUT_RESTART_TIMEOUT: Final Cut Pro did not quit");
    },
    probe: async () => { throw new Error("socket missing"); },
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "needs-user-action");
  assert.equal(status.lastError?.code, "FINAL_CUT_RESTART_TIMEOUT");
});
