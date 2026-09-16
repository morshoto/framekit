import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutBackgroundMaterializationPublisher } from "@framekit/final-cut";

const desired = {
  schemaVersion: 1 as const,
  project: { id: "project-1", name: "Project" },
  sequence: {
    id: "sequence-1", name: "Main", durationTime: { value: "30", timescale: "30" }, frameDuration: { value: "1", timescale: "30" },
    occurrences: [], storyElements: [], markers: [], captions: [],
  },
  resources: [],
  revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
};

test("publishes only a digest-verified staged artifact through an explicit background capability", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-materialization-"));
  try {
    const artifactPath = join(directory, "staged.fcpxml");
    const artifact = "<fcpxml version=\"1.11\"><library/></fcpxml>";
    await writeFile(artifactPath, artifact, "utf8");
    const requests: unknown[] = [];
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      executor: async (request) => {
        requests.push(request);
        return { state: "completed", canonicalReadback: desired, headedNativeVerified: false };
      },
    });

    const result = await publisher.publish({
      jobId: "materialization-1",
      artifactPath,
      artifactDigest: createHash("sha256").update(artifact).digest("hex"),
      target: { provider: "final-cut", projectUid: "project-1", sequenceUid: "sequence-1", eventName: "Framekit" },
      destination: { mode: "versioned", projectUid: "project-2", sequenceUid: "sequence-2", projectName: "Project v2", sequenceName: "Main" },
      desired,
    });

    assert.equal(result.state, "completed");
    assert.equal(requests.length, 1);
    await writeFile(artifactPath, "changed", "utf8");
    await assert.rejects(
      publisher.publish({
        jobId: "materialization-1",
        artifactPath,
        artifactDigest: createHash("sha256").update(artifact).digest("hex"),
        target: { provider: "final-cut", projectUid: "project-1", sequenceUid: "sequence-1", eventName: "Framekit" },
        destination: { mode: "versioned", projectUid: "project-2", sequenceUid: "sequence-2", projectName: "Project v2", sequenceName: "Main" },
        desired,
      }),
      /MATERIALIZATION_ARTIFACT_CHANGED/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds a hanging background command as a retryable blocker", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-materialization-timeout-"));
  try {
    const artifactPath = join(directory, "staged.fcpxml");
    const artifact = "<fcpxml version=\"1.11\"><library/></fcpxml>";
    const commandPath = join(directory, "hanging-publisher");
    await writeFile(artifactPath, artifact, "utf8");
    await writeFile(commandPath, "#!/bin/sh\nwhile :; do :; done\n", "utf8");
    await chmod(commandPath, 0o755);
    const publisher = new FinalCutBackgroundMaterializationPublisher({ command: commandPath, commandTimeoutMs: 20 });

    const result = await publisher.publish({
      jobId: "materialization-timeout",
      artifactPath,
      artifactDigest: createHash("sha256").update(artifact).digest("hex"),
      target: { provider: "final-cut", projectUid: "project-1", sequenceUid: "sequence-1", eventName: "Framekit" },
      destination: { mode: "versioned", projectUid: "project-2", sequenceUid: "sequence-2", projectName: "Project v2", sequenceName: "Main" },
      desired,
    });

    assert.equal(result.state, "blocked");
    assert.equal(result.code, "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT");
    assert.equal(result.retryable, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wires a background publisher only when its command capability is configured", async () => {
  const main = await (await import("node:fs/promises")).readFile("apps/mcp-server/src/main.ts", "utf8");
  assert.match(main, /FRAMEKIT_FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND/);
  assert.match(main, /sessionMaterializationPublisher/);
});
