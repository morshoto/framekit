import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FINAL_CUT_LIVE_PROTOCOL_VERSION,
  UnixSocketFinalCutLiveTransport,
} from "@framekit/final-cut";

test("Final Cut live transport round-trips newline-delimited JSON over a Unix socket", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-live-ipc-"));
  const socketPath = join(directory, "bridge.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; version: number };
      socket.end(`${JSON.stringify({
        version: request.version,
        id: request.id,
        ok: true,
        result: {
          identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
          capabilities: {
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
            },
            analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
          },
        },
      })}\n`);
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const response = await new UnixSocketFinalCutLiveTransport(socketPath).request({
      version: FINAL_CUT_LIVE_PROTOCOL_VERSION,
      id: "request-1",
      method: "capabilities",
    });
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.equal(response.result.identity.backend, "workflow-extension-ipc");
      assert.equal(response.result.capabilities.editor.timelineSnapshotRead, false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Final Cut live transport retries bounded read-only requests after a transient socket failure", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-live-ipc-retry-"));
  const socketPath = join(directory, "bridge.sock");
  let requests = 0;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; version: number };
      requests += 1;
      if (requests === 1) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({
        version: request.version,
        id: request.id,
        ok: true,
        result: {
          identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
          capabilities: {
            editor: {
              projectRead: false,
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
            },
            analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
          },
        },
      })}\n`);
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const response = await new UnixSocketFinalCutLiveTransport(socketPath, 50).request({
      version: FINAL_CUT_LIVE_PROTOCOL_VERSION,
      id: "request-retry",
      method: "state",
    });
    assert.equal(response.ok, true);
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
