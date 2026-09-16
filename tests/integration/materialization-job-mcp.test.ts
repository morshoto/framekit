import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type SessionMaterializationPublisher } from "../../apps/mcp-server/src/server.js";
import { AgentVideoRuntime, type TimelineIr } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "300", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [], markers: [], captions: [],
    },
    resources: [{ id: "media-1", name: "opening.mov", mediaKind: "video", source: "/media/opening.mov" }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-15T00:00:00.000Z" },
  };
}

function runtime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project", projectName: "Fixture", timelineId: "fixture-sequence", timelineName: "Main", clips: [], media: [],
  }));
}

function payload(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return JSON.parse(content?.[0]?.text ?? "null");
}

async function connect(directory: string, publisher?: SessionMaterializationPublisher) {
  const server = createMcpServer(runtime(), {
    sessionDirectory: join(directory, "sessions"),
    materializationDirectory: join(directory, "materializations"),
    ...(publisher ? { sessionMaterializationPublisher: publisher } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "materialization-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const target = {
  provider: "final-cut",
  libraryUid: "library-1",
  eventUid: "event-1",
  projectUid: "project-1",
  sequenceUid: "sequence-1",
  eventName: "Framekit",
};

function canonicalTarget(request: {
  target: Pick<typeof target, "libraryUid" | "eventUid" | "projectUid" | "sequenceUid">;
  destination: { projectUid: string; sequenceUid: string };
}) {
  return {
    libraryUid: request.target.libraryUid,
    eventUid: request.target.eventUid,
    projectUid: request.destination.projectUid,
    sequenceUid: request.destination.sequenceUid,
  };
}

test("previews without mutation and resumes a blocked immutable materialization job", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-1", provider: { id: "final-cut" }, base: timeline() } });
    await first.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-1",
        expectedRevision: timeline().revision,
        operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Opening revised" }],
      },
    });

    const preview = payload(await first.client.callTool({ name: "session.materialize.preview", arguments: { sessionId: "session-1", target } }));
    assert.equal(preview.mutating, false);
    assert.equal(preview.destination.mode, "versioned");
    assert.notEqual(preview.destination.projectUid, target.projectUid);
    await assert.rejects(readdir(join(directory, "materializations")), /ENOENT/);

    const unconfirmed = await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-1", target, confirm: false },
    });
    assert.equal(unconfirmed.isError, true);
    assert.equal(payload(unconfirmed).code, "MATERIALIZATION_CONFIRMATION_REQUIRED");

    const executed = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-1", target, confirm: true },
    }));
    assert.equal(executed.state, "blocked");
    assert.equal(executed.nextAction, "retry");
    assert.equal(executed.evidence.artifact.verified, true);
    assert.equal(executed.evidence.providerRequested, false);
    assert.equal(executed.evidence.canonicalReadback, false);
    assert.equal(executed.evidence.headedNative, false);
    assert.match(executed.artifactPath, /\.fcpxml$/);

    await first.client.close();
    await first.server.close();
    const resumedRequests: string[] = [];
    const second = await connect(directory, {
      publish: async (request) => {
        resumedRequests.push(request.jobId);
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    const restored = payload(await second.client.callTool({
      name: "session.materialize.status",
      arguments: { jobId: executed.jobId },
    }));
    assert.equal(restored.state, "blocked");
    assert.equal(restored.artifactDigest, executed.artifactDigest);
    const resumed = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: executed.jobId },
    }));
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.jobId, executed.jobId);
    assert.deepEqual(resumedRequests, [executed.jobId]);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not advertise retry for non-retryable provider blockers", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-nonretryable-"));
  try {
    const connected = await connect(directory, {
      publish: async () => ({
        state: "blocked",
        code: "FINAL_CUT_TARGET_UNAVAILABLE",
        message: "The requested target is unavailable",
        retryable: false,
      }),
    });
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-nonretryable", provider: { id: "final-cut" }, base: timeline() },
    });
    const blocked = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-nonretryable", target, confirm: true },
    }));
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.nextAction, "none");
    assert.equal(blocked.error.retryable, false);
    const retry = await connected.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: blocked.jobId },
    });
    assert.equal(retry.isError, true);
    assert.equal(payload(retry).code, "MATERIALIZATION_NOT_RETRYABLE");
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completes only after matching canonical provider readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-provider-"));
  const published: Array<{ artifactPath: string; projectUid: string }> = [];
  const publisher: SessionMaterializationPublisher = {
    publish: async (request) => {
      published.push({ artifactPath: request.artifactPath, projectUid: request.destination.projectUid });
      return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
    },
  };
  try {
    const connected = await connect(directory, publisher);
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-success", provider: { id: "final-cut" }, base: timeline() } });
    const completed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-success", target, confirm: true },
    }));

    assert.equal(completed.state, "completed");
    assert.equal(completed.evidence.providerRequested, true);
    assert.equal(completed.evidence.canonicalReadback, true);
    assert.equal(completed.evidence.headedNative, false);
    assert.equal(published.length, 1);
    assert.notEqual(published[0]?.projectUid, target.projectUid);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires canonical readback to identify the created target", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-target-"));
  try {
    const connected = await connect(directory, {
      publish: async (request) => ({
        state: "completed",
        canonicalReadback: request.desired,
        canonicalTarget: {
          libraryUid: request.target.libraryUid,
          eventUid: request.target.eventUid,
          projectUid: "wrong-project",
          sequenceUid: request.destination.sequenceUid,
        },
        headedNativeVerified: false,
      } as any),
    });
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-target", provider: { id: "final-cut" }, base: timeline() } });
    const failed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-target", target, confirm: true },
    }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_TARGET_READBACK_MISMATCH");
    assert.equal(failed.evidence.canonicalReadback, false);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the persisted session changes after staging", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-snapshot-"));
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-snapshot", provider: { id: "final-cut" }, base: timeline() } });
    await first.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-snapshot",
        expectedRevision: timeline().revision,
        operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Staged desired" }],
      },
    });
    const blocked = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-snapshot", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const sessionPath = join(directory, "sessions", "session-snapshot.json");
    const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
    persisted.desired.sequence.occurrences[0].name = "Changed after staging";
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const requests: TimelineIr[] = [];
    const second = await connect(directory, {
      publish: async (request) => {
        requests.push(request.desired);
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    const resumed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: blocked.jobId } }));
    assert.equal(resumed.state, "failed");
    assert.equal(resumed.error.code, "MATERIALIZATION_SESSION_CHANGED");
    assert.equal(requests.length, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically claims a retry so concurrent attempts publish once", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-claim-"));
  let release: () => void = () => undefined;
  let calls = 0;
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-claim", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-claim", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const publisher = {
      publish: async (request: Parameters<SessionMaterializationPublisher["publish"]>[0]) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return { state: "completed" as const, canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    } satisfies SessionMaterializationPublisher;
    const left = await connect(directory, publisher);
    const right = await connect(directory, publisher);
    const leftRetry = left.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } });
    const deadline = Date.now() + 5_000;
    while (calls === 0) {
      assert.ok(Date.now() < deadline, "publisher.publish was not called");
      await new Promise((resolve) => setImmediate(resolve));
    }
    const rightRetry = payload(await right.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(rightRetry.state, "publishing");
    assert.equal(calls, 1);
    release();
    const completed = payload(await leftRetry);
    assert.equal(completed.state, "completed");
    assert.equal(payload(await right.client.callTool({ name: "session.materialize.status", arguments: { jobId: staged.jobId } })).state, "completed");
    await left.client.close();
    await left.server.close();
    await right.client.close();
    await right.server.close();
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles an abandoned claim before retrying publication", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-recovery-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-recovery", provider: { id: "final-cut" }, base: timeline() },
    });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-recovery", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const jobPath = join(directory, "materializations", "jobs", `${staged.jobId}.json`);
    const persisted = JSON.parse(await readFile(jobPath, "utf8"));
    persisted.state = "publishing";
    persisted.nextAction = "status";
    persisted.claim = {
      id: "stale-claim",
      claimedAt: "2026-09-15T00:00:00.000Z",
      leaseExpiresAt: "2026-09-15T00:01:00.000Z",
    };
    delete persisted.error;
    await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeFile(`${jobPath}.claim`, `${JSON.stringify({ jobId: staged.jobId, ...persisted.claim })}\n`, "utf8");

    let reconcileCalls = 0;
    let publishCalls = 0;
    const second = await connect(directory, {
      publish: async () => {
        publishCalls += 1;
        return { state: "blocked", code: "UNEXPECTED", message: "publication should not run", retryable: false };
      },
      reconcile: async (request) => {
        reconcileCalls += 1;
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false } as never;
      },
    });
    const recovered = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: staged.jobId },
    }));
    assert.equal(recovered.state, "completed");
    assert.equal(reconcileCalls, 1);
    assert.equal(publishCalls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries only after reconciliation proves no publication completed", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-retry-recovery-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-retry-recovery", provider: { id: "final-cut" }, base: timeline() },
    });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-retry-recovery", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const jobPath = join(directory, "materializations", "jobs", `${staged.jobId}.json`);
    const persisted = JSON.parse(await readFile(jobPath, "utf8"));
    persisted.state = "publishing";
    persisted.nextAction = "status";
    persisted.claim = {
      id: "expired-claim",
      claimedAt: "2026-09-15T00:00:00.000Z",
      leaseExpiresAt: "2026-09-15T00:01:00.000Z",
    };
    delete persisted.error;
    await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeFile(`${jobPath}.claim`, `${JSON.stringify({ jobId: staged.jobId, ...persisted.claim })}\n`, "utf8");

    let reconcileCalls = 0;
    let publishCalls = 0;
    const second = await connect(directory, {
      publish: async (request) => {
        publishCalls += 1;
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { state: "not-found" } as never;
      },
    });
    const recovered = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: staged.jobId },
    }));
    assert.equal(recovered.state, "completed");
    assert.equal(reconcileCalls, 1);
    assert.equal(publishCalls, 1);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an uncertain publication recovery-required when reconciliation is unknown", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-unknown-recovery-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-unknown-recovery", provider: { id: "final-cut" }, base: timeline() },
    });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-unknown-recovery", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const jobPath = join(directory, "materializations", "jobs", `${staged.jobId}.json`);
    const persisted = JSON.parse(await readFile(jobPath, "utf8"));
    persisted.state = "publishing";
    persisted.nextAction = "status";
    persisted.claim = {
      id: "unknown-claim",
      claimedAt: "2026-09-15T00:00:00.000Z",
      leaseExpiresAt: "2026-09-15T00:01:00.000Z",
    };
    delete persisted.error;
    await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeFile(`${jobPath}.claim`, `${JSON.stringify({ jobId: staged.jobId, ...persisted.claim })}\n`, "utf8");

    let publishCalls = 0;
    const second = await connect(directory, {
      publish: async () => {
        publishCalls += 1;
        return { state: "blocked", code: "UNEXPECTED", message: "publication should not run", retryable: false };
      },
      reconcile: async () => ({ state: "unknown", code: "PROVIDER_UNCERTAIN", message: "the provider cannot determine publication state", retryable: false }),
    });
    const recovered = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: staged.jobId },
    }));
    assert.equal(recovered.state, "blocked");
    assert.equal(recovered.nextAction, "status");
    assert.equal(recovered.error.recovery, "required");
    assert.equal(recovered.error.retryable, false);
    assert.equal(publishCalls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not persist a completion after the publication claim is fenced", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-fenced-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-fenced", provider: { id: "final-cut" }, base: timeline() },
    });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-fenced", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const jobPath = join(directory, "materializations", "jobs", `${staged.jobId}.json`);
    let publishCalls = 0;
    const second = await connect(directory, {
      publish: async (request) => {
        publishCalls += 1;
        await unlink(`${jobPath}.claim`);
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
      reconcile: async () => ({ state: "unknown", code: "PROVIDER_UNCERTAIN", message: "the provider cannot determine publication state", retryable: false }),
    });
    const result = payload(await second.client.callTool({
      name: "session.materialize.retry",
      arguments: { jobId: staged.jobId },
    }));
    assert.equal(publishCalls, 1);
    assert.equal(result.state, "blocked");
    assert.equal(result.nextAction, "status");
    assert.equal(result.error.recovery, "required");
    assert.equal(result.error.code, "MATERIALIZATION_CLAIM_FENCED");
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the session changes after staging", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-session-drift-"));
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-drift", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-drift", target, confirm: true },
    }));
    const changed = payload(await first.client.callTool({
      name: "session.edit.execute",
      arguments: {
        sessionId: "session-drift",
        operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-1", name: "Changed after staging" }],
      },
    }));
    assert.equal(changed.document.desired.sequence.occurrences[0]?.name, "Changed after staging");
    await first.client.close();
    await first.server.close();

    let calls = 0;
    const second = await connect(directory, {
      publish: async (request) => {
        calls += 1;
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    const failed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_SESSION_CHANGED");
    assert.equal(calls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a changed staged artifact before retry publication", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-artifact-drift-"));
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-artifact-drift", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-artifact-drift", target, confirm: true },
    }));
    await writeFile(staged.artifactPath, "changed", "utf8");
    await first.client.close();
    await first.server.close();

    let calls = 0;
    const second = await connect(directory, {
      publish: async (request) => {
        calls += 1;
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    const failed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_ARTIFACT_CHANGED");
    assert.equal(calls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a tampered persisted desired snapshot before retry publication", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-desired-drift-"));
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-desired-drift", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-desired-drift", target, confirm: true },
    }));
    const jobPath = join(directory, "materializations", "jobs", `${staged.jobId}.json`);
    const persisted = JSON.parse(await readFile(jobPath, "utf8"));
    persisted.desired.project.name = "Tampered desired";
    await writeFile(jobPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await first.client.close();
    await first.server.close();

    let calls = 0;
    const second = await connect(directory, {
      publish: async (request) => {
        calls += 1;
        return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    const failed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_DESIRED_SNAPSHOT_INVALID");
    assert.equal(calls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("documents session tools persistence and materialization evidence boundaries", async () => {
  const tools = await readFile("docs/mcp/tools.md", "utf8");
  const architecture = await readFile("docs/architecture/headless-editing-sessions.md", "utf8");

  for (const tool of [
    "session.create",
    "session.observe",
    "session.reconcile",
    "session.materialize.preview",
    "session.materialize.execute",
    "session.materialize.status",
    "session.materialize.retry",
  ]) {
    assert.match(tools, new RegExp(tool.replaceAll(".", "\\.")));
  }
  assert.match(architecture, /FRAMEKIT_STATE_DIR/);
  assert.match(architecture, /canonical: false/);
  assert.match(architecture, /artifact.*provider-requested.*canonical-readback.*headed-native/s);
  assert.match(architecture, /does not write.*SQLite/i);
  assert.match(architecture, /FRAMEKIT_FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND/);
  assert.match(architecture, /publishing/);
  assert.match(architecture, /recovery-required/);
  assert.match(architecture, /not-found/);
  assert.match(tools, /reconcile/);
  assert.match(tools, /libraryUid.*eventUid.*projectUid.*sequenceUid/s);
});
