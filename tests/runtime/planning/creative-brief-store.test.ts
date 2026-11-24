import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreativeBrief } from "../../../packages/runtime/src/planning/creative-brief.js";
import { JsonCreativeBriefStore, assertCurrentAcceptedBrief } from "../../../packages/runtime/src/application/creative-brief-store.js";

const brief: CreativeBrief = {
  schemaVersion: 1, id: "brief-1", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" },
  durationSeconds: { min: 30, max: 60 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural",
  requiredContent: [], excludedContent: [], sourceCoverage: [], speechPolicy: { kind: "specified", value: "preserve" },
  musicPolicy: { kind: "specified", value: "none" }, captionPolicy: { kind: "specified", value: "basic" }, inferences: [], reviewPrompts: [],
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "framekit-brief-store-"));
  const path = join(dir, "brief.json");
  return { dir, path, store: new JsonCreativeBriefStore(path) };
}

test("explicit acceptance is stored and revisions invalidate old approval across restart", async () => {
  const f = await fixture();
  try {
    const draft = await f.store.create("project-1", brief);
    assert.equal(draft.state, "draft");
    await assert.rejects(() => assertCurrentAcceptedBrief(f.store, "project-1", { id: brief.id, version: 1, digest: draft.digest }), /BRIEF_NOT_ACCEPTED/);
    const accepted = await f.store.accept("project-1", draft.digest);
    assert.equal(accepted.state, "accepted");
    const oldApproval = accepted.accepted!;
    const reopened = new JsonCreativeBriefStore(f.path);
    await assertCurrentAcceptedBrief(reopened, "project-1", oldApproval);
    const revised = await reopened.revise("project-1", draft.digest, { ...brief, theme: "changed" });
    assert.equal(revised.state, "draft");
    assert.equal(revised.brief.version, 2);
    await assert.rejects(() => assertCurrentAcceptedBrief(reopened, "project-1", oldApproval), /BRIEF_NOT_ACCEPTED|STALE_BRIEF/);
    await assert.rejects(() => reopened.accept("project-1", draft.digest), /STALE_BRIEF/);
    const newlyAccepted = await reopened.accept("project-1", revised.digest);
    assert.equal(newlyAccepted.state, "accepted");
    const newApproval = newlyAccepted.accepted;
    await assertCurrentAcceptedBrief(reopened, "project-1", newApproval);
    await assert.rejects(() => assertCurrentAcceptedBrief(reopened, "project-1", oldApproval), /STALE_BRIEF/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("concurrent revisions admit one winner and preserve project identity", async () => {
  const f = await fixture();
  try {
    const draft = await f.store.create("project-1", brief);
    const competing = await Promise.allSettled([
      f.store.revise("project-1", draft.digest, { ...brief, theme: "warm" }),
      new JsonCreativeBriefStore(f.path).revise("project-1", draft.digest, { ...brief, theme: "cool" }),
    ]);
    assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(competing.filter((item) => item.status === "rejected").length, 1);
    await assert.rejects(() => f.store.read("other-project"), /TARGET_MISMATCH/);
    await assert.rejects(() => f.store.create("project-1", brief), /ALREADY_EXISTS/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("accepted-brief operation excludes a concurrent revision and rejects stale approval", async () => {
  const f = await fixture();
  try {
    const draft = await f.store.create("project-1", brief);
    const accepted = await f.store.accept("project-1", draft.digest);
    if (accepted.state !== "accepted") throw new Error("expected accepted brief");
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const operation = f.store.withAcceptedBrief("project-1", accepted.accepted!, async () => { entered(); await blocked; return "done"; });
    await started;
    await assert.rejects(new JsonCreativeBriefStore(f.path).revise("project-1", draft.digest, { ...brief, theme: "changed" }), /BRIEF_BUSY/);
    release(); assert.equal(await operation, "done");
    await assert.rejects(f.store.withAcceptedBrief("project-1", accepted.accepted!, async () => { throw new Error("operation failed"); }), /operation failed/);
    await f.store.revise("project-1", draft.digest, { ...brief, theme: "changed" });
    let ran = false;
    await assert.rejects(f.store.withAcceptedBrief("project-1", accepted.accepted!, async () => { ran = true; }), /BRIEF_NOT_ACCEPTED|STALE_BRIEF/);
    assert.equal(ran, false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a stale approval cannot be changed while stored acceptance is read", async () => {
  const f = await fixture();
  try {
    const draft = await f.store.create("project-1", brief);
    const accepted = await f.store.accept("project-1", draft.digest);
    if (accepted.state !== "accepted") throw new Error("expected accepted brief");
    const stale = { ...accepted.accepted, digest: "0".repeat(64) };
    const checking = assertCurrentAcceptedBrief(f.store, "project-1", stale);
    stale.digest = accepted.accepted.digest;
    await assert.rejects(checking, /STALE_BRIEF/);
    const staleForOperation = { ...accepted.accepted, digest: "0".repeat(64) };
    let ran = false;
    const operation = f.store.withAcceptedBrief("project-1", staleForOperation, async () => { ran = true; });
    staleForOperation.digest = accepted.accepted.digest;
    await assert.rejects(operation, /STALE_BRIEF/);
    assert.equal(ran, false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a proposed revision is fixed before waiting for the store lock", async () => {
  const f = await fixture();
  try {
    const draft = await f.store.create("project-1", brief);
    const proposed = { ...brief, theme: "reviewed" };
    const operation = f.store.revise("project-1", draft.digest, proposed);
    proposed.theme = "changed while waiting";
    const revised = await operation;
    assert.equal(revised.brief.theme, "reviewed");
    assert.equal((await f.store.read("project-1")).brief.theme, "reviewed");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("unreviewed drafts cannot be accepted and corrupt persisted approval fails closed", async () => {
  const f = await fixture();
  try {
    const pending = { ...brief, inferences: [{ field: "pacing", value: "slow", reason: "interview", accepted: false }] };
    const draft = await f.store.create("project-1", pending);
    await assert.rejects(() => f.store.accept("project-1", draft.digest), /inference/i);
    const raw = JSON.parse(await readFile(f.path, "utf8"));
    raw.state = "accepted"; raw.accepted = { id: brief.id, version: 1, digest: "forged" };
    await writeFile(f.path, JSON.stringify(raw));
    await assert.rejects(() => f.store.read("project-1"), /CORRUPT/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("brief store is available through the runtime entrypoint", async () => {
  const runtime = await import("../../../packages/runtime/src/index.js");
  assert.equal(typeof (runtime as Record<string, unknown>).JsonCreativeBriefStore, "function");
  assert.equal(typeof (runtime as Record<string, unknown>).assertCurrentAcceptedBrief, "function");
});
