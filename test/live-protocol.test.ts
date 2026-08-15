import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FINAL_CUT_LIVE_PROTOCOL_VERSION,
  UnixSocketFinalCutLiveTransport,
} from "../src/adapters/final-cut-live.js";

test("Final Cut live transport round-trips newline-delimited JSON over a Unix socket", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "playhead-live-ipc-"));
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
          capabilities: { projectRead: true, timelineRead: false },
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
      assert.equal(response.result.capabilities.timelineRead, false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
