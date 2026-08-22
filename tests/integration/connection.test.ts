import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutConnectionManager } from "@framekit/final-cut";

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

test("headless connection probes an existing bridge without launching or activating Final Cut", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
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

test("headless connection fails closed when the existing bridge is unavailable", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
    detectFinalCut: async () => { events.push("detect"); return true; },
    launchFinalCut: async () => { events.push("launch"); },
    activateExtension: async () => { events.push("activate"); },
    probe: async () => { throw new Error("socket missing"); },
  });

  const status = await manager.ensureConnected();
  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError?.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
  assert.deepEqual(events, []);
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
