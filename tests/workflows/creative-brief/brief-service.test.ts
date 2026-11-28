import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FramekitProjectStore, JsonCreativeBriefStore, type CreativeBrief, type FramekitProjectDocument } from "../../../packages/runtime/src/index.js";
import { assertCreativeBriefProjectBinding, HeadlessCreativeBriefService } from "../../../packages/headless-application/src/creative-brief-service.js";

const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const digest = "a".repeat(64);
const brief: CreativeBrief = {
  schemaVersion: 1, id: "brief", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" },
  durationSeconds: { min: 30, max: 60 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural",
  requiredContent: ["introduction"], excludedContent: [], sourceCoverage: [{ requirement: "introduction", sourceId: "media", sourceDigest: digest, start: 0, end: 10 }],
  speechPolicy: { kind: "specified", value: "preserve" }, musicPolicy: { kind: "specified", value: "none" }, captionPolicy: { kind: "specified", value: "basic" }, inferences: [], reviewPrompts: [],
};
const project = { timeline: { project: { id: "p" }, sequence: { id: "t" }, revision,
  resources: [{ id: "media", source: "/fixture/media.mov", sourceKind: "local-file", sourceDigest: digest, mediaKind: "video", metadata: { durationTime: { value: "12", timescale: "1" }, streams: [] } }] } } as unknown as FramekitProjectDocument;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-service-"));
  let current = structuredClone(project);
  const projectStore = new FramekitProjectStore(join(dir, "project.json"));
  const store = new JsonCreativeBriefStore(join(dir, "brief.json"), (binding, operation) => projectStore.withProjectLock(async (locked) => {
    assertCreativeBriefProjectBinding(binding, current);
    return operation(locked);
  }));
  const service = new HeadlessCreativeBriefService({ openProject: async () => structuredClone(current), withProjectLock: async (_projectId, operation) => operation(), storeForProject: () => store });
  return { dir, store, service, setProject: (value: FramekitProjectDocument) => { current = structuredClone(value); },
    withRender: (render: any) => new HeadlessCreativeBriefService({ openProject: async () => structuredClone(current), withProjectLock: async (_id, operation) => operation(), storeForProject: () => store, render }) };
}
const target = { projectId: "p", sequenceId: "t", expectedRevision: revision };

test("draft, review, explicitly accept and revise without editing the project", async () => {
  const f = await fixture();
  try {
    const initial = structuredClone(project);
    const draft = await f.service.create({ ...target, brief });
    assert.equal(draft.record.state, "draft");
    assert.deepEqual(draft.review.missingCoverage, []);
    assert.equal(draft.sourceCoverage, "matched");
    assert.match(draft.notice, /content.*review/i);
    await assert.rejects(() => f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: false }), /CONFIRM/);
    const accepted = await f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    assert.equal(accepted.record.state, "accepted");
    const revised = await f.service.revise({ ...target, expectedDigest: draft.record.digest, brief: { ...brief, theme: "changed" } });
    assert.equal(revised.record.state, "draft");
    assert.equal(revised.record.brief.version, 2);
    assert.deepEqual(project, initial);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("brief render inspection binds current project and reverified artifact without claiming complete acceptance", async () => {
  const f = await fixture();
  try {
    const current = structuredClone(project);
    const stored = { renderId: "render-fixture", projectId: "p", sequenceId: "t", requestedRevision: revision, status: "passed", outcome: { plan: { timeline: current.timeline } } };
    const observation = { status: "passed", target: { projectId: "p", sequenceId: "t" }, revision, fileDigest: "b".repeat(64), durationSeconds: 45, width: 1080, height: 1920 };
    let record = structuredClone(stored);
    let verified = true;
    const service = f.withRender({ inspect: async () => structuredClone(record), reverify: async () => verified ? { status: "verified", observation: structuredClone(observation) } : { status: "unavailable" } });
    const draft = await service.create({ ...target, brief });
    await service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    const result = await service.inspectRender({ ...target, renderId: "render-fixture" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.nativeAcceptance, "unavailable");
    assert.deepEqual(result.checks.map((check: any) => check.status), ["matches", "matches"]);
    assert.equal(result.binding.artifactDigest, observation.fileDigest);
    assert.match(result.notice, /not.*(approval|execution)/i);
    verified = false;
    assert.equal((await service.inspectRender({ ...target, renderId: "render-fixture" })).status, "unavailable");
    verified = true;
    record.outcome.plan.timeline.sequence.id = "other";
    assert.equal((await service.inspectRender({ ...target, renderId: "render-fixture" })).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("source drift and stale targets cannot accept an old brief", async () => {
  const f = await fixture();
  try {
    const draft = await f.service.create({ ...target, brief });
    const changed = structuredClone(project);
    changed.timeline.resources[0]!.sourceDigest = "b".repeat(64);
    f.setProject(changed);
    const inspected = await f.service.inspect(target);
    assert.equal(inspected.sourceCoverage, "unavailable");
    await assert.rejects(() => f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true }), /COVERAGE/);
    f.setProject(project);
    await assert.rejects(() => f.service.accept({ ...target, expectedRevision: { ...revision, sequence: 2 }, expectedDigest: draft.record.digest, confirmed: true }), /STALE/);
    assert.equal((await f.store.read("p")).state, "draft");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("accepted brief cannot authorize a consumer after the project revision changes", async () => {
  const f = await fixture();
  try {
    const draft = await f.service.create({ ...target, brief });
    const accepted = await f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    if (accepted.record.state !== "accepted") throw new Error("expected acceptance");
    const approval = accepted.record.accepted;
    const reopenedWithoutVerifier = new JsonCreativeBriefStore(join(f.dir, "brief.json"));
    await assert.rejects(() => reopenedWithoutVerifier.withAcceptedBrief("p", approval, async () => {}), /BRIEF_TARGET_UNVERIFIED/);
    assert.equal(await f.store.withAcceptedBrief("p", approval, async () => "current"), "current");
    const changed = structuredClone(project);
    changed.timeline.revision = { ...revision, id: "r2", sequence: 2 };
    f.setProject(changed);
    let executed = false;
    await assert.rejects(() => f.store.withAcceptedBrief("p", approval, async () => { executed = true; }), /STALE|BRIEF_NOT_ACCEPTED/);
    assert.equal(executed, false);
    const changedWithoutRevision = structuredClone(project);
    changedWithoutRevision.timeline.resources[0]!.sourceDigest = "b".repeat(64);
    f.setProject(changedWithoutRevision);
    await assert.rejects(() => f.store.withAcceptedBrief("p", approval, async () => { executed = true; }), /STALE/);
    assert.equal(executed, false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("malformed stored project bindings fail closed", async () => {
  const f = await fixture();
  try {
    const draft = await f.service.create({ ...target, brief });
    await f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = join(f.dir, "brief.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.projectBinding = null;
    await writeFile(path, JSON.stringify(data));
    await assert.rejects(() => f.store.read("p"), /BRIEF_CORRUPT/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a bound consumer excludes a cooperating project change through its operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-use-race-"));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const validating = new Promise<void>((resolve) => { entered = resolve; });
  let current = structuredClone(project);
  try {
    const projectStore = new FramekitProjectStore(join(dir, "project.json"));
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"), (binding, operation) => projectStore.withProjectLock(async (locked) => {
      assertCreativeBriefProjectBinding(binding, current);
      entered(); await paused;
      return operation(locked);
    }));
    const service = new HeadlessCreativeBriefService({ openProject: async () => structuredClone(current),
      withProjectLock: async (_id, operation) => operation(), storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    const accepted = await service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    if (accepted.record.state !== "accepted") throw new Error("expected accepted");
    let ran = false;
    const operation = store.withAcceptedBrief("p", accepted.record.accepted, async () => { ran = true; });
    await validating;
    let changed = false;
    const writer = projectStore.withProjectLock(async () => { current.timeline.revision = { ...revision, id: "r2", sequence: 2 }; changed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(changed, false);
    release();
    await operation; await writer;
    assert.equal(ran, true);
    assert.equal(changed, true);
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test("a project change while the bound consumer waits for the lock is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-wait-race-"));
  let release!: () => void; let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let current = structuredClone(project);
  try {
    const projectStore = new FramekitProjectStore(join(dir, "project.json"));
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"), (binding, operation) => projectStore.withProjectLock(async (locked) => {
      assertCreativeBriefProjectBinding(binding, current); return operation(locked);
    }));
    const service = new HeadlessCreativeBriefService({ openProject: async () => structuredClone(current),
      withProjectLock: async (_id, operation) => projectStore.withProjectLock(operation), storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    const accepted = await service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    if (accepted.record.state !== "accepted") throw new Error("expected accepted");
    const writer = projectStore.withProjectLock(async () => { entered(); await paused; current.timeline.revision = { ...revision, id: "r2", sequence: 2 }; });
    await started;
    let ran = false;
    const operation = store.withAcceptedBrief("p", accepted.record.accepted, async () => { ran = true; });
    release(); await writer;
    await assert.rejects(operation, /STALE_CONTEXT/);
    assert.equal(ran, false);
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test("a project change during acceptance invalidates the newly accepted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-race-"));
  try {
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
    let opens = 0;
    const service = new HeadlessCreativeBriefService({ openProject: async () => {
      const result = structuredClone(project);
      if (++opens >= 3) result.timeline.revision = { ...revision, sequence: 2 };
      return result;
    }, withProjectLock: async (_projectId, operation) => operation(), storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    await assert.rejects(() => service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true }), /STALE|RECONCILIATION/);
    assert.equal((await store.read("p")).state, "draft");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("acceptance is not usable while project validation is in progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-publication-"));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const validating = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
    let opens = 0;
    const service = new HeadlessCreativeBriefService({ openProject: async () => {
      if (++opens === 3) { entered(); await paused; }
      return structuredClone(project);
    }, withProjectLock: async (_projectId, operation) => operation(), storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    const accepting = service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    await validating;
    await assert.rejects(() => store.read("p"), /BRIEF_RECONCILIATION_REQUIRED/);
    let ran = false;
    await assert.rejects(() => store.withAcceptedBrief("p", { id: brief.id, version: brief.version, digest: draft.record.digest }, async () => { ran = true; }), /BRIEF_BUSY/);
    assert.equal(ran, false);
    release();
    assert.equal((await accepting).record.state, "accepted");
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test("an interrupted publication remains unavailable after reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-interrupted-"));
  try {
    const path = join(dir, "brief.json");
    const store = new JsonCreativeBriefStore(path);
    const draft = await store.create("p", brief);
    await store.accept("p", draft.digest);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${path}.accepting`, "interrupted\n");
    const reopened = new JsonCreativeBriefStore(path);
    await assert.rejects(() => reopened.read("p"), /BRIEF_RECONCILIATION_REQUIRED/);
    await assert.rejects(() => reopened.withAcceptedBrief("p", { id: brief.id, version: brief.version, digest: draft.digest }, async () => {}), /BRIEF_RECONCILIATION_REQUIRED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("publication holds the project writer lock through the final validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-project-lock-"));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const validating = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
    const projectStore = new FramekitProjectStore(join(dir, "project.json"));
    let opens = 0;
    const service = new HeadlessCreativeBriefService({ openProject: async () => {
      if (++opens === 3) { entered(); await paused; }
      return structuredClone(project);
    }, withProjectLock: async (_id, operation) => projectStore.withProjectLock(operation), storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    const accepting = service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    await validating;
    let writerEntered = false;
    const writer = new FramekitProjectStore(join(dir, "project.json")).withProjectLock(async () => { writerEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(writerEntered, false);
    release();
    assert.equal((await accepting).record.state, "accepted");
    await writer;
    assert.equal(writerEntered, true);
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test("a concurrent brief revision cannot be reported as the accepted result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-concurrent-"));
  try {
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
    let opens = 0;
    let expectedDigest = "";
    const service = new HeadlessCreativeBriefService({ openProject: async () => {
      if (++opens === 3) await store.revise("p", expectedDigest, { ...brief, theme: "concurrent" });
      return structuredClone(project);
    }, withProjectLock: async (_projectId, operation) => operation(), storeForProject: () => store });
    const draft = await service.create({ ...target, brief }); expectedDigest = draft.record.digest;
    await assert.rejects(() => service.accept({ ...target, expectedDigest, confirmed: true }), /STALE|RECONCILIATION|NOT_ACCEPTED|BRIEF_BUSY/);
    assert.equal((await store.read("p")).state, "draft");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("MCP exposes project-bound review and explicit acceptance without timeline mutation", async () => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/index.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { createMcpServer } = await import("../../../apps/mcp-server/src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const f = await fixture();
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "fixture", projectName: "Fixture", timelineId: "sequence", timelineName: "Main", clips: [] }));
  const server = createMcpServer(runtime, { headlessBriefs: f.service });
  const client = new Client({ name: "brief-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const before = await runtime.inspectProject();
    const created = await client.callTool({ name: "headless.brief.create", arguments: { ...target, brief } });
    assert.notEqual(created.isError, true);
    const response = JSON.parse((created.content as Array<{ text: string }>)[0]!.text);
    assert.equal(response.record.state, "draft");
    const beforeAcceptance = await client.callTool({ name: "headless.brief.inspect-timeline-coverage", arguments: target });
    assert.equal(beforeAcceptance.isError, true);
    const denied = await client.callTool({ name: "headless.brief.accept", arguments: { ...target, expectedDigest: response.record.digest, confirmed: false } });
    assert.equal(denied.isError, true);
    const accepted = await client.callTool({ name: "headless.brief.accept", arguments: { ...target, expectedDigest: response.record.digest, confirmed: true } });
    assert.notEqual(accepted.isError, true);
    assert.equal(JSON.parse((accepted.content as Array<{ text: string }>)[0]!.text).record.state, "accepted");
    const coverage = await client.callTool({ name: "headless.brief.inspect-timeline-coverage", arguments: target });
    assert.notEqual(coverage.isError, true);
    assert.equal(JSON.parse((coverage.content as Array<{ text: string }>)[0]!.text).checks[0].status, "unavailable");
    assert.deepEqual(await runtime.inspectProject(), before);
  } finally { await client.close(); await server.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("accepted target reports timeline coverage without asserting final artifact conformance", async () => {
  const f = await fixture();
  try {
    const current = structuredClone(project);
    current.timeline.resources[0]!.name = "Media";
    current.timeline.resources[0]!.metadata!.streams = [{ kind: "video", frameRate: { value: "30", timescale: "1" } }];
    Object.assign(current.timeline, { schemaVersion: 1, project: { id: "p", name: "P" }, sequence: {
      id: "t", name: "T", durationTime: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "30" },
      occurrences: [{ id: "clip", name: "Clip", mediaId: "media", role: "video", track: 0,
        startTime: { value: "0", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }],
      storyElements: [], markers: [], captions: [],
    } });
    f.setProject(current);
    const draft = await f.service.create({ ...target, brief });
    await assert.rejects(() => f.service.inspectTimelineCoverage(target), /BRIEF_NOT_ACCEPTED/);
    await f.service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true });
    const result = await f.service.inspectTimelineCoverage(target);
    assert.equal(result.checks[0]?.status, "present");
    assert.equal(result.checks[0]?.sourceDigest, digest);
    assert.deepEqual(result.binding.revision, revision);
    assert.equal(result.binding.projectId, "p");
    assert.equal(result.binding.briefDigest, draft.record.digest);
    assert.match(result.notice, /not.*(render|output)/i);
    const changed = structuredClone(current);
    changed.timeline.sequence.occurrences[0]!.durationTime.value = "9";
    f.setProject(changed);
    await assert.rejects(() => f.service.inspectTimelineCoverage(target), /STALE/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
