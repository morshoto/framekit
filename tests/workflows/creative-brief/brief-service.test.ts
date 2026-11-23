import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCreativeBriefStore, type CreativeBrief, type FramekitProjectDocument } from "../../../packages/runtime/src/index.js";
import { HeadlessCreativeBriefService } from "../../../packages/headless-application/src/creative-brief-service.js";

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
  const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const service = new HeadlessCreativeBriefService({ openProject: async () => structuredClone(current), storeForProject: () => store });
  return { dir, store, service, setProject: (value: FramekitProjectDocument) => { current = structuredClone(value); } };
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

test("a project change during acceptance invalidates the newly accepted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-race-"));
  try {
    const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
    let opens = 0;
    const service = new HeadlessCreativeBriefService({ openProject: async () => {
      const result = structuredClone(project);
      if (++opens >= 3) result.timeline.revision = { ...revision, sequence: 2 };
      return result;
    }, storeForProject: () => store });
    const draft = await service.create({ ...target, brief });
    await assert.rejects(() => service.accept({ ...target, expectedDigest: draft.record.digest, confirmed: true }), /STALE|RECONCILIATION/);
    assert.equal((await store.read("p")).state, "draft");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
