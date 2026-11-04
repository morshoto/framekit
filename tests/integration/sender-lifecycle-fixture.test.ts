import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectSenderFixture, startSenderFixture } from "../../packages/testkit/src/sender-lifecycle-fixture.js";

const id = "a".repeat(64);
const owner = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000002";
const binding = { reservationId: id, reservationVersion: 3 as const, route: "publish" as const, owner, executionId };

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "framekit-sender-fixture-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("timed out waiting for sender state");
}
const delayedChild = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600)); console.log('ready'); setInterval(() => {}, 1000);";

test("both route fixtures record direct child settlement without native proof", async () => fixture(async directory => {
  for (const route of ["publish", "materialization"] as const) {
    const input = { ...binding, route, reservationId: route === "publish" ? id : "b".repeat(64) };
    const running = await startSenderFixture(directory, input, { command: process.execPath, args: ["-e", "process.exit(0)"] });
    await running.closed;
    const observed = await inspectSenderFixture(directory, input);
    assert.equal(observed.status, "sender-settled");
    assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.recoveryEligibility, "unavailable");
  }
}));

test("abort remains requested while the direct child delays exit", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], killAfterMs: 3000 });
  try {
    await once(running.child.stdout!, "data");
    await running.abort();
    assert.equal((await inspectSenderFixture(directory, binding)).status, "abort-requested");
    let closed = false; void running.closed.then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(closed, false);
    await running.closed;
    assert.equal((await inspectSenderFixture(directory, binding)).status, "sender-settled");
  } finally { running.child.kill("SIGKILL"); await running.closed; }
}));

test("timeout records abort while a child is still running", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], timeoutMs: 350, killAfterMs: 3000 });
  try {
    await once(running.child.stdout!, "data");
    await waitFor(async () => (await inspectSenderFixture(directory, binding)).status === "abort-requested");
    assert.equal(running.child.exitCode, null);
    await running.closed;
    assert.equal((await inspectSenderFixture(directory, binding)).status, "sender-settled");
  } finally { running.child.kill("SIGKILL"); await running.closed; }
}));

test("wrong identities and missing or corrupted records remain unknown", async () => fixture(async directory => {
  assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], killAfterMs: 3000 });
  try {
    await once(running.child.stdout!, "data");
    assert.equal((await inspectSenderFixture(directory, { ...binding, owner: "00000000-0000-4000-8000-000000000003" })).status, "unknown");
    assert.equal((await inspectSenderFixture(directory, { ...binding, reservationId: "f".repeat(64) })).status, "unknown");
    await writeFile(join(directory, `${id}.sender-abort`), "broken");
    assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
  } finally { running.child.kill("SIGKILL"); await running.closed; }
}));

test("legacy v2 is never retroactively tracked", async () => fixture(async directory => {
  await assert.rejects(startSenderFixture(directory, { ...binding, reservationVersion: 2 as never }, { command: process.execPath, args: ["-e", "process.exit(0)"] }));
  assert.deepEqual(await readdir(directory), []);
}));

test("an exited child is never signalled using a potentially reused PID", async () => fixture(async directory => {
  const parent = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),500)'],{stdio:['ignore',1,2]}); c.unref(); process.exit(0);";
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", parent] });
  await once(running.child, "exit");
  let signals = 0;
  running.child.kill = (() => { signals++; return true; }) as typeof running.child.kill;
  await running.abort();
  assert.equal(signals, 0);
  await running.closed;
}));
