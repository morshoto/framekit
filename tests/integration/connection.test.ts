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
    playbackControl: false,
  },
  analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
};

test("connection manager reports a ready live bridge without installing anything", async () => {
  const manager = new FinalCutConnectionManager({
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

test("connection manager remains actionable when the extension is missing", async () => {
  const manager = new FinalCutConnectionManager({
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
