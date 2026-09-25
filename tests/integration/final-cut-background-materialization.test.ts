import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutBackgroundMaterializationPublisher } from "@framekit/final-cut";
import { timelineIrDigest } from "@framekit/runtime";

const desired = {
  schemaVersion: 1 as const,
  project: { id: "project-1", name: "Project" },
  sequence: {
    id: "sequence-1",
    name: "Main",
    durationTime: { value: "30", timescale: "30" },
    frameDuration: { value: "1", timescale: "30" },
    occurrences: [],
    storyElements: [],
    markers: [],
    captions: [],
  },
  resources: [],
  revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
};

function request(artifactPath: string, artifact: string) {
  return {
    jobId: "materialization-1",
    artifactPath,
    artifactDigest: createHash("sha256").update(artifact).digest("hex"),
    target: {
      provider: "final-cut",
      libraryUid: "library-1",
      eventUid: "event-1",
      projectUid: "project-1",
      sequenceUid: "sequence-1",
    },
    destination: {
      mode: "versioned",
      projectUid: "project-1-framekit-abc123",
      sequenceUid: "sequence-1-framekit-abc123",
      projectName: "Project (Framekit abc123)",
      sequenceName: "Main (Framekit abc123)",
    },
    collisionPolicy: "create-only",
    desired,
    desiredDigest: timelineIrDigest(desired),
  } as never;
}

test("publishes a verified artifact with an explicit target and canonical readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-"));
  try {
    const artifact = "<fcpxml version=\"1.11\"><library/></fcpxml>";
    const artifactPath = join(directory, "staged.fcpxml");
    await writeFile(artifactPath, artifact, "utf8");
    let received: any;
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      executor: async (value) => {
        received = value;
        return {
          state: "completed",
          canonicalReadback: desired,
          canonicalTarget: {
            libraryUid: "library-1",
            eventUid: "event-1",
            projectUid: "project-1-framekit-abc123",
            sequenceUid: "sequence-1-framekit-abc123",
          },
          headedNativeVerified: false,
        };
      },
    });

    const result = await publisher.publish(request(artifactPath, artifact));

    assert.equal(result.state, "completed");
    assert.equal(received.target.libraryUid, "library-1");
    assert.equal(received.destination.mode, "versioned");
    assert.equal(received.collisionPolicy, "create-only");
    assert.equal(received.desired.project.id, "project-1");
    assert.deepEqual(result.delivery, {
      route: "document-open",
      activation: "unknown",
      interaction: "unknown",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a structured blocker when no background capability is configured", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-unavailable-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    await writeFile(artifactPath, artifact, "utf8");
    const result = await new FinalCutBackgroundMaterializationPublisher().publish(request(artifactPath, artifact));
    assert.deepEqual(result, {
      state: "blocked",
      code: "FINAL_CUT_BACKGROUND_MATERIALIZATION_UNAVAILABLE",
      message: "No explicit non-UI Final Cut materialization capability is configured",
      retryable: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a changed artifact before invoking the background capability", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-digest-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    await writeFile(artifactPath, "changed", "utf8");
    let invoked = false;
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      executor: async () => {
        invoked = true;
        return { state: "blocked", code: "UNEXPECTED", message: "unexpected", retryable: true };
      },
    });
    await assert.rejects(
      publisher.publish(request(artifactPath, artifact)),
      /MATERIALIZATION_ARTIFACT_CHANGED/,
    );
    assert.equal(invoked, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a locked-console blocker and never reports headed proof", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-locked-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    await writeFile(artifactPath, artifact, "utf8");
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      executor: async () => ({
        state: "blocked",
        code: "FINAL_CUT_CONSOLE_LOCKED",
        message: "The macOS console is locked",
        retryable: true,
      }),
    });
    const result = await publisher.publish(request(artifactPath, artifact));
    assert.equal(result.state, "blocked");
    assert.equal(result.code, "FINAL_CUT_CONSOLE_LOCKED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invokes the configured command through its stdin and stdout contract", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-command-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    const commandPath = join(directory, "publisher.sh");
    await writeFile(artifactPath, artifact, "utf8");
    await writeFile(commandPath, "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"state\":\"blocked\",\"code\":\"FINAL_CUT_CONSOLE_LOCKED\",\"message\":\"locked\",\"retryable\":true}'\n", "utf8");
    await chmod(commandPath, 0o755);
    const publisher = new FinalCutBackgroundMaterializationPublisher({ command: commandPath });
    const result = await publisher.publish(request(artifactPath, artifact));
    assert.deepEqual(result, {
      state: "blocked",
      code: "FINAL_CUT_CONSOLE_LOCKED",
      message: "locked",
      retryable: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds a hanging background command as a retryable blocker", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-timeout-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    const commandPath = join(directory, "hanging-publisher");
    await writeFile(artifactPath, artifact, "utf8");
    await writeFile(commandPath, "#!/bin/sh\nwhile :; do :; done\n", "utf8");
    await chmod(commandPath, 0o755);
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      command: commandPath,
      commandTimeoutMs: 20,
    });

    const result = await publisher.publish(request(artifactPath, artifact));

    assert.equal(result.state, "blocked");
    assert.equal(result.code, "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_TIMEOUT");
    assert.equal(result.retryable, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a background response that claims headed-native verification", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-publisher-evidence-"));
  try {
    const artifact = "<fcpxml/>";
    const artifactPath = join(directory, "staged.fcpxml");
    await writeFile(artifactPath, artifact, "utf8");
    const publisher = new FinalCutBackgroundMaterializationPublisher({
      executor: async () => ({
        state: "completed",
        canonicalReadback: desired,
        canonicalTarget: {
          libraryUid: "library-1",
          eventUid: "event-1",
          projectUid: "project-1-framekit-abc123",
          sequenceUid: "sequence-1-framekit-abc123",
        },
        headedNativeVerified: true,
      }),
    });
    await assert.rejects(
      publisher.publish(request(artifactPath, artifact)),
      /FINAL_CUT_BACKGROUND_MATERIALIZATION_RESPONSE_INVALID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production MCP wiring requires an explicit background capability", async () => {
  const main = await readFile("apps/mcp-server/src/main.ts", "utf8");
  assert.match(main, /FRAMEKIT_FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND/);
  assert.match(main, /FinalCutBackgroundMaterializationPublisher/);
  assert.match(main, /sessionMaterializationPublisher\?\.isAvailable\(\)/);
});
