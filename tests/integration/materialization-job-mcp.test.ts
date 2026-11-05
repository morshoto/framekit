import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type SessionMaterializationPublisher } from "../../apps/mcp-server/src/server.js";
import { FileCanonicalRecoveryGuard, FinalCutBackgroundMaterializationPublisher } from "@framekit/final-cut";
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

async function connect(
  directory: string,
  publisher?: SessionMaterializationPublisher,
  sessionChangeSource?: {
    changesSince(revision: TimelineIr["revision"]): Promise<{
      from: TimelineIr["revision"];
      to: TimelineIr["revision"];
    }>;
  },
  sessionChangeSourceOverride: "omit" | "default" = "default",
  canonicalRecovery?: FileCanonicalRecoveryGuard,
) {
  const changeSource = sessionChangeSourceOverride === "omit"
    ? undefined
    : sessionChangeSource ?? {
        changesSince: async (revision: TimelineIr["revision"]) => ({ from: revision, to: revision }),
      };
  const server = createMcpServer(runtime(), {
    sessionDirectory: join(directory, "sessions"),
    materializationDirectory: join(directory, "materializations"),
    ...(publisher ? { sessionMaterializationPublisher: publisher } : {}),
    ...(canonicalRecovery ? { canonicalRecovery } : {}),
    ...(changeSource ? { sessionChangeSource: changeSource } : {}),
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
    assert.equal(preview.coverage.exact.includes("provenance"), true);
    assert.equal(preview.coverage.unsupported.length, 0);
    assert.equal(preview.provenance.source, "framekit-timeline-ir");
    assert.match(preview.provenance.revision.id, /^ir:[a-f0-9]{64}$/);
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
    assert.deepEqual(executed.verification, {
      tier: "artifact",
      status: "blocked",
      artifactDigest: executed.artifactDigest,
      desiredDigest: executed.desiredDigest,
      reason: "No Final Cut materialization publisher is configured; retry when a provider is available",
    });
    assert.deepEqual(executed.coverage, preview.coverage);
    assert.deepEqual(executed.provenance, preview.provenance);
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
    assert.deepEqual(restored.provenance, executed.provenance);
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

test("recovers legacy jobs without target-bound materialization metadata", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-legacy-"));
  try {
    const first = await connect(directory);
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-legacy", provider: { id: "final-cut" }, base: timeline() } });
    const executed = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-legacy", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const jobPath = join(directory, "materializations", "jobs", `${executed.jobId}.json`);
    const legacy = JSON.parse(await readFile(jobPath, "utf8"));
    legacy.schemaVersion = 1;
    delete legacy.coverage;
    delete legacy.provenance;
    await writeFile(jobPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const requests: string[] = [];
    const second = await connect(directory, {
      publish: async (request) => {
        requests.push(request.jobId);
        return { state: "blocked", code: "UNEXPECTED", message: "publisher must not receive legacy metadata", retryable: true };
      },
    });
    const restored = payload(await second.client.callTool({ name: "session.materialize.status", arguments: { jobId: executed.jobId } }));
    assert.equal(restored.state, "failed");
    assert.equal(restored.error.code, "MATERIALIZATION_JOB_METADATA_UNAVAILABLE");
    assert.equal(restored.error.retryable, false);
    const retried = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: executed.jobId } }));
    assert.equal(retried.state, "failed");
    assert.deepEqual(requests, []);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completes only after matching canonical provider readback", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-provider-"));
  const published: Array<{ artifactPath: string; projectUid: string; timelineDigest: string }> = [];
  const publisher: SessionMaterializationPublisher = {
    publish: async (request) => {
      published.push({ artifactPath: request.artifactPath, projectUid: request.destination.projectUid, timelineDigest: request.provenance.timelineDigest });
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
    assert.equal(completed.verification.tier, "canonical-verified");
    assert.equal(completed.verification.status, "verified");
    assert.equal(published.length, 1);
    assert.notEqual(published[0]?.projectUid, target.projectUid);
    assert.match(published[0]?.timelineDigest ?? "", /^[a-f0-9]{64}$/);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists a retryable blocker when the configured publisher command fails", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-command-failure-"));
  try {
    const first = await connect(directory, new FinalCutBackgroundMaterializationPublisher({
      command: join(directory, "missing-publisher"),
    }));
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-command-failure", provider: { id: "final-cut" }, base: timeline() } });

    const executed = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-command-failure", target, confirm: true },
    }));

    assert.equal(executed.state, "blocked");
    assert.equal(executed.error.code, "FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND_UNAVAILABLE");
    assert.equal(executed.error.retryable, true);
    assert.equal(executed.evidence.providerRequested, true);

    const restored = payload(await first.client.callTool({
      name: "session.materialize.status",
      arguments: { jobId: executed.jobId },
    }));
    assert.equal(restored.error.code, executed.error.code);
    assert.equal(restored.error.retryable, true);
    await first.client.close();
    await first.server.close();
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

test("fails closed when the canonical base changes after staging", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-base-drift-"));
  const providerRevision = {
    id: "provider-revision-after-staging",
    sequence: 2,
    timestamp: "2026-09-15T00:02:00.000Z",
  };
  let calls = 0;
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-base-drift", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-base-drift", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const second = await connect(directory, {
      publish: async () => {
        calls += 1;
        return { state: "completed", canonicalReadback: timeline(), canonicalTarget: canonicalTarget({ target, destination: { projectUid: "project-1-framekit-abc123", sequenceUid: "sequence-1-framekit-abc123" } }), headedNativeVerified: false };
      },
    }, {
      changesSince: async (revision) => ({ from: revision, to: providerRevision }),
    });
    const failed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_BASE_CHANGED");
    assert.equal(failed.verification.status, "failed");
    assert.equal(calls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports an explicit unavailable verification when no canonical change source exists", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-base-unavailable-"));
  let calls = 0;
  try {
    const first = await connect(directory, {
      publish: async () => ({ state: "blocked", code: "TEMPORARY", message: "try again", retryable: true }),
    });
    await first.client.callTool({ name: "session.create", arguments: { sessionId: "session-no-source", provider: { id: "final-cut" }, base: timeline() } });
    const staged = payload(await first.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-no-source", target, confirm: true },
    }));
    await first.client.close();
    await first.server.close();

    const second = await connect(directory, {
      publish: async () => {
        calls += 1;
        return { state: "completed", canonicalReadback: timeline(), canonicalTarget: canonicalTarget({ target, destination: { projectUid: "project-1-framekit-abc123", sequenceUid: "sequence-1-framekit-abc123" } }), headedNativeVerified: false };
      },
    }, undefined, "omit");
    const failed = payload(await second.client.callTool({ name: "session.materialize.retry", arguments: { jobId: staged.jobId } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_BASE_UNAVAILABLE");
    assert.equal(failed.verification.tier, "artifact");
    assert.equal(failed.verification.status, "failed");
    assert.equal(calls, 0);
    await second.client.close();
    await second.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a target-bound structural diff when canonical readback mismatches", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-structural-diff-"));
  try {
    const connected = await connect(directory, {
      publish: async (request) => {
        const canonicalReadback = structuredClone(request.desired);
        canonicalReadback.sequence.occurrences[0]!.name = "Canonical mismatch";
        return { state: "completed", canonicalReadback, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
      },
    });
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-structural-diff", provider: { id: "final-cut" }, base: timeline() } });
    const failed = payload(await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-structural-diff", target, confirm: true },
    }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "MATERIALIZATION_READBACK_MISMATCH");
    assert.equal(failed.verification.tier, "delivery");
    assert.equal(failed.verification.status, "failed");
    assert.equal(failed.verification.structuralDiff.target.projectId, "project-1");
    assert.deepEqual(failed.verification.structuralDiff.changes, [{
      path: "sequence.occurrences[0].name",
      before: "Opening",
      after: "Canonical mismatch",
    }]);
    await connected.client.close();
    await connected.server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically claims a retry so concurrent attempts publish once", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-claim-"));
  let release!: () => void;
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
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
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

test("blocks materialization preview and execute after provider drift", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-provider-drift-"));
  const providerRevision = {
    id: "provider-revision-2",
    sequence: 2,
    timestamp: "2026-09-15T00:02:00.000Z",
  };
  let publisherCalls = 0;
  try {
    const connected = await connect(directory, {
      publish: async () => {
        publisherCalls += 1;
        return { state: "blocked", code: "UNEXPECTED", message: "must not publish", retryable: false };
      },
    }, {
      changesSince: async (revision) => ({ from: revision, to: providerRevision }),
    });
    await connected.client.callTool({
      name: "session.create",
      arguments: { sessionId: "session-provider-drift", provider: { id: "final-cut" }, base: timeline() },
    });

    const preview = await connected.client.callTool({
      name: "session.materialize.preview",
      arguments: { sessionId: "session-provider-drift", target },
    });
    assert.equal(preview.isError, true);
    assert.equal(payload(preview).code, "RECONCILIATION_REQUIRED");

    const execute = await connected.client.callTool({
      name: "session.materialize.execute",
      arguments: { sessionId: "session-provider-drift", target, confirm: true },
    });
    assert.equal(execute.isError, true);
    assert.equal(payload(execute).code, "RECONCILIATION_REQUIRED");
    assert.equal(publisherCalls, 0);
    await connected.client.close();
    await connected.server.close();
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

test("materialization excludes canonical edits and never retries an uncertain publication", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-reservation-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let publishes = 0;
  let runningJobId = "";
  let execution: ReturnType<Client["callTool"]> | undefined;
  const connected = await connect(directory, {
    publish: async (request) => {
      publishes += 1;
      runningJobId = request.jobId;
      started();
      await held;
      return { state: "completed", canonicalReadback: request.desired, canonicalTarget: canonicalTarget(request), headedNativeVerified: false };
    },
  }, undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-guarded", provider: { id: "final-cut" }, base: timeline() } });
    execution = connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-guarded", target, confirm: true } });
    await entered;
    try {
      const running = payload(await connected.client.callTool({ name: "session.materialize.status", arguments: { jobId: runningJobId } }));
      assert.equal(running.state, "publishing");
      assert.equal(running.evidence.providerRequested, true);
      assert.equal(running.providerRequestPhase, "dispatch-intent");
      const durable = JSON.parse(await readFile(path, "utf8"));
      assert.equal(durable.version, 3);
      assert.equal(durable.recoveryContext.jobId, runningJobId);
      assert.equal(durable.recoveryContext.artifactDigest, running.artifactDigest);
      assert.deepEqual(durable.recoveryContext.destination, running.destination);
      assert.deepEqual(durable.recoveryContext.requestedTarget, {
        libraryUid: target.libraryUid, eventUid: target.eventUid, projectUid: target.projectUid, sequenceUid: target.sequenceUid,
      });
      await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "a".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally { finish(); }
    const result = payload(await execution);
    assert.equal(result.state, "blocked");
    assert.equal(result.error.code, "FINAL_CUT_CANONICAL_RECOVERY_REQUIRED");
    assert.equal(result.error.retryable, false);
    assert.equal(result.evidence.providerRequested, true);
    assert.equal(result.evidence.canonicalReadback, true);
    assert.equal(result.verification.tier, "canonical-verified");
    assert.match(result.continuation.reason, /recovery is required/i);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await connected.client.callTool({ name: "session.materialize.retry", arguments: { jobId: result.jobId } });
    assert.equal(publishes, 1);
  } finally {
    finish();
    await execution?.catch(() => undefined);
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkpoint won before provider dispatch preserves truthful materialization evidence", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-checkpoint-race-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  const beginNative = guard.beginNative.bind(guard);
  guard.beginNative = async (operation) => {
    await other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "a".repeat(64), operation: "rename-clip" });
    return beginNative(operation);
  };
  let publishes = 0;
  const connected = await connect(directory, { publish: async () => { publishes += 1; throw new Error("must not publish"); } }, undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-race", provider: { id: "final-cut" }, base: timeline() } });
    const result = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-race", target, confirm: true } }));
    assert.equal(result.state, "blocked");
    assert.equal(result.error.code, "FINAL_CUT_CANONICAL_RECOVERY_REQUIRED");
    assert.equal(result.error.retryable, true);
    assert.equal(result.evidence.providerRequested, false);
    assert.match(result.verification.reason, /reservation.*provider was not called/i);
    assert.equal(publishes, 0);
    await other.complete();
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialization retains provider failure evidence and forbids an uncertain retry", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-uncertain-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  let publishes = 0;
  const publisher: SessionMaterializationPublisher = { publish: async () => {
    publishes += 1;
    return { state: "blocked", code: "DELIVERY_TIMEOUT", message: "delivery outcome unknown", retryable: true };
  } };
  const connected = await connect(directory, publisher, undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-uncertain", provider: { id: "final-cut" }, base: timeline() } });
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-uncertain", target, confirm: true } }));
    assert.equal(job.state, "blocked");
    assert.equal(job.nextAction, "none");
    assert.equal(job.error.code, "FINAL_CUT_CANONICAL_RECOVERY_REQUIRED");
    assert.equal(job.error.retryable, false);
    assert.equal(job.providerError.code, "DELIVERY_TIMEOUT");
    assert.equal(job.evidence.providerRequested, true);
    const restarted = await connect(directory, publisher, undefined, "default", new FileCanonicalRecoveryGuard(path));
    try {
      const retry = await restarted.client.callTool({ name: "session.materialize.retry", arguments: { jobId: job.jobId } });
      assert.equal(retry.isError, true);
      assert.equal(publishes, 1);
    } finally {
      await restarted.client.close();
      await restarted.server.close();
    }
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialization retains a reservation when an invoked provider omits dispatch acknowledgement", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-no-dispatch-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const publisher: SessionMaterializationPublisher = {
    trackNativeDispatch: async (call) => call(),
    publish: async () => ({ state: "blocked", code: "TEMPORARY_UNAVAILABLE", message: "provider did not dispatch", retryable: true }),
  };
  const connected = await connect(directory, publisher, undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-no-dispatch", provider: { id: "final-cut" }, base: timeline() } });
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-no-dispatch", target, confirm: true } }));
    assert.equal(job.state, "blocked");
    assert.equal(job.nextAction, "none");
    assert.equal(job.error.code, "FINAL_CUT_CANONICAL_RECOVERY_REQUIRED");
    assert.equal(job.error.retryable, false);
    assert.equal(job.evidence.providerRequested, true);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("built-in materialization preflight without an executor permits a safe retry", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-built-in-preflight-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const connected = await connect(directory, new FinalCutBackgroundMaterializationPublisher(), undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-preflight", provider: { id: "final-cut" }, base: timeline() } });
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-preflight", target, confirm: true } }));
    assert.equal(job.nextAction, "retry");
    assert.equal(job.error.code, "FINAL_CUT_BACKGROUND_MATERIALIZATION_UNAVAILABLE");
    await guard.assertClear();
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing reservation takes precedence over unavailable built-in preflight", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-existing-preflight-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const connected = await connect(directory, new FinalCutBackgroundMaterializationPublisher(), undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-existing", provider: { id: "final-cut" }, base: timeline() } });
    await guard.beginNative("native.searchmedia");
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-existing", target, confirm: true } }));
    assert.equal(job.code, "FINAL_CUT_CANONICAL_RECOVERY_REQUIRED");
    assert.equal((await guard.inspectNativeReservation())?.operation, "native.searchmedia");
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialization does not claim a provider request when tracking fails first", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-tracking-failure-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  let publishes = 0;
  const publisher: SessionMaterializationPublisher = {
    trackNativeDispatch: async () => { throw new Error("TRACKING_UNAVAILABLE: no provider invocation"); },
    publish: async () => { publishes += 1; throw new Error("must not invoke"); },
  };
  const connected = await connect(directory, publisher, undefined, "default", guard);
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-track-failure", provider: { id: "final-cut" }, base: timeline() } });
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-track-failure", target, confirm: true } }));
    assert.equal(job.state, "failed");
    assert.equal(job.evidence.providerRequested, false);
    assert.equal(publishes, 0);
    await guard.assertClear();
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider timeout without a dispatch callback remains reserved after restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-materialization-timeout-"));
  const path = join(directory, "pending.json");
  let calls = 0;
  const publisher: SessionMaterializationPublisher = {
    trackNativeDispatch: async (call) => call(),
    publish: async () => { calls++; throw new Error("RECEIVER_TIMEOUT: acknowledgement missing"); },
  };
  const connected = await connect(directory, publisher, undefined, "default", new FileCanonicalRecoveryGuard(path));
  try {
    await connected.client.callTool({ name: "session.create", arguments: { sessionId: "session-timeout", provider: { id: "final-cut" }, base: timeline() } });
    const job = payload(await connected.client.callTool({ name: "session.materialize.execute", arguments: { sessionId: "session-timeout", target, confirm: true } }));
    assert.equal(job.evidence.providerRequested, true);
    assert.equal(job.nextAction, "none");
    const restarted = new FileCanonicalRecoveryGuard(path);
    assert.equal((await restarted.inspectNativeRecoveryEvidence()).dispatchState, "possibly-dispatched");
    await assert.rejects(restarted.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await connected.client.callTool({ name: "session.materialize.retry", arguments: { jobId: job.jobId } });
    assert.equal(calls, 1);
  } finally {
    await connected.client.close();
    await connected.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
