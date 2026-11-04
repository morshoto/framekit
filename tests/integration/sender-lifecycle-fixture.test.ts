import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspectSenderFixture, startSenderFixture } from "@framekit/testkit";

const owner = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000002";
function fixtureBinding(route: "publish" | "materialization") {
  const reservationBytes = JSON.stringify({ version: 3, kind: "native-operation", owner, operation: `fixture.${route}`, senderTracked: true }) + "\n";
  return { reservationId: createHash("sha256").update(reservationBytes).digest("hex"), reservationBytes, reservationVersion: 3 as const, route, owner, executionId };
}
const binding = fixtureBinding("publish");
const id = binding.reservationId;

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
    const input = fixtureBinding(route);
    const running = await startSenderFixture(directory, input, { command: process.execPath, args: ["-e", "process.exit(0)"] });
    await running.closed;
    const observed = await inspectSenderFixture(directory, input);
    assert.equal(observed.status, "sender-settled");
    assert.equal(observed.evidenceTrust, "unverified-fixture-marker");
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
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("timeout records abort while a child is still running", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], timeoutMs: 350, killAfterMs: 3000 });
  try {
    await once(running.child.stdout!, "data");
    await waitFor(async () => (await inspectSenderFixture(directory, binding)).status === "abort-requested");
    assert.equal(running.child.exitCode, null);
    await running.closed;
    assert.equal((await inspectSenderFixture(directory, binding)).status, "sender-settled");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
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
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("legacy v2 is never retroactively tracked", async () => fixture(async directory => {
  const legacy = JSON.stringify({ version: 2, kind: "native-operation", operation: "native.searchmedia" });
  await writeFile(join(directory, "pending.json"), legacy);
  await assert.rejects(startSenderFixture(directory, { ...binding, reservationVersion: 2 as never }, { command: process.execPath, args: ["-e", "process.exit(0)"] }));
  assert.deepEqual(await readdir(directory), ["pending.json"]);
  assert.equal(await readFile(join(directory, "pending.json"), "utf8"), legacy);
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


test("a crashed runner leaves a retained, ambiguous sender across restart", async () => fixture(async directory => {
  const module = pathToFileURL(resolve("packages/testkit/src/sender-lifecycle-fixture.ts")).href;
  const script = `import {startSenderFixture} from ${JSON.stringify(module)};
    const job = await startSenderFixture(process.argv[1], ${JSON.stringify(binding)}, {command:process.execPath,args:['-e',"process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready')"]});
    job.child.stdout.once('data',()=>console.log('ready')); await new Promise(()=>{});`;
  const runner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(runner, "close");
  try {
    await Promise.race([once(runner.stdout, "data"), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("runner did not start")), 5000); timer.unref(); })]);
    runner.kill("SIGKILL");
    await closed;
    assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
    await assert.rejects(startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", "process.exit(0)"] }));
    assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
  } finally { if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL"); }
}));

test("a separate process cannot claim an existing reservation identity", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
  try {
    await once(running.child.stdout!, "data");
    const module = pathToFileURL(resolve("packages/testkit/src/sender-lifecycle-fixture.ts")).href;
    const script = `import {startSenderFixture} from ${JSON.stringify(module)}; try { await startSenderFixture(process.argv[1], ${JSON.stringify(binding)}, {command:process.execPath,args:['-e','process.exit(0)']}); process.exit(1); } catch { process.exit(0); }`;
    const other = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { timeout: 5000, encoding: "utf8" });
    assert.equal(other.status, 0, other.stderr);
    assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("a legacy writer can coexist without any claim of exclusion", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
  try {
    await once(running.child.stdout!, "data");
    const legacy = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'legacy', {flag:'wx'})", join(directory, "pending.json")], { timeout: 5000 });
    assert.equal(legacy.status, 0);
    assert.equal(await readFile(join(directory, "pending.json"), "utf8"), "legacy");
    assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("a reused PID in untrusted markers makes evidence unknown", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
  try {
    await once(running.child.stdout!, "data");
    const marker = join(directory, `${id}.sender-start`);
    const data = JSON.parse(await readFile(marker, "utf8"));
    data.pid = process.pid;
    await writeFile(marker, JSON.stringify(data));
    assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));


test("two MCP processes observe legacy coexistence without mutating reservation state", async () => fixture(async directory => {
  const path = join(directory, "pending.json");
  const legacy = JSON.stringify({ version: 2, kind: "native-operation", owner, operation: "native.searchmedia" }) + "\n";
  await writeFile(path, legacy);
  await mkdir(`${path}.lock`);
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
  const url = (file: string) => pathToFileURL(resolve(file)).href;
  const script = `import {AgentVideoRuntime} from ${JSON.stringify(url("packages/runtime/src/index.ts"))};
    import {InMemoryEditorAdapter} from ${JSON.stringify(url("packages/testkit/src/in-memory-editor.ts"))};
    import {FileCanonicalRecoveryGuard} from ${JSON.stringify(url("adapters/final-cut/typescript/src/canonical-recovery-guard.ts"))};
    import {createMcpServer} from ${JSON.stringify(url("apps/mcp-server/src/server.ts"))};
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    const fixture = {projectId:'p',projectName:'p',timelineId:'s',timelineName:'s',clips:[]};
    const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(fixture));
    await createMcpServer(runtime,{canonicalRecovery:new FileCanonicalRecoveryGuard(process.env.TEST_RESERVATION_PATH)}).connect(new StdioServerTransport());`;
  const clients = [new Client({ name: "sender-observer-a", version: "1" }), new Client({ name: "sender-observer-b", version: "1" })];
  const transports = clients.map(() => new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", script], env: { ...process.env, TEST_RESERVATION_PATH: path }, stderr: "pipe" }));
  try {
    await once(running.child.stdout!, "data");
    const before = await readFile(path, "utf8");
    const beforeEntries = (await readdir(directory)).sort();
    await Promise.all(clients.map((client, i) => client.connect(transports[i]!)));
    assert.notEqual(transports[0]!.pid, transports[1]!.pid);
    const results = await Promise.all(clients.map(client => client.callTool({ name: "editor.native.recovery.evidence.inspect", arguments: {} })));
    for (const result of results) {
      const item = (result.content as Array<{ text: string }>)[0]!;
      const value = JSON.parse(item.text);
      assert.equal(value.status, "unknown");
      assert.equal(value.nativeQuiescence, "unproven");
      assert.equal(value.recoveryEligibility, "unavailable");
    }
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual((await readdir(directory)).sort(), beforeEntries);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    await running.closed;
  }
}));

test("inspection fails closed when sender evidence changes during observation", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
  try {
    await once(running.child.stdout!, "data");
    const observed = await inspectSenderFixture(directory, binding, { beforeRecheck: async () => {
      await writeFile(join(directory, `${id}.sender-settled`), "corrupt");
    } });
    assert.equal(observed.status, "unknown");
    assert.equal(observed.recoveryEligibility, "unavailable");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("local sender activity is distinct from restart-ambiguous evidence", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], killAfterMs: 3000 });
  try {
    await once(running.child.stdout!, "data");
    assert.equal(running.localStatus(), "active");
    assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
    await running.abort();
    assert.equal(running.localStatus(), "abort-requested");
    await running.closed;
    assert.equal(running.localStatus(), "sender-settled");
    assert.equal((await inspectSenderFixture(directory, binding)).nativeQuiescence, "unproven");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("a failed spawn never reports a sender active or settled", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: join(directory, "missing-command"), args: [] });
  assert.equal(running.localStatus(), "unknown");
  await running.closed;
  assert.equal(running.localStatus(), "unknown");
  assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
}));

test("abort of a failed spawn does not invent a termination request", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: join(directory, "missing-command"), args: [] });
  await running.abort();
  await running.closed;
  assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
  assert.equal(running.localStatus(), "unknown");
}));

test("an unresponsive direct child is killed only while the local handle is live", async () => fixture(async directory => {
  const script = "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);";
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", script], killAfterMs: 150 });
  try {
    await once(running.child.stdout!, "data");
    await running.abort();
    await running.closed;
    assert.equal(running.child.signalCode, "SIGKILL");
    assert.equal((await inspectSenderFixture(directory, binding)).status, "sender-settled");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));

test("missing or mismatched settlement cannot report settled", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", "process.exit(0)"] });
  await running.closed;
  const marker = join(directory, `${id}.sender-settled`);
  await rm(marker);
  assert.equal((await inspectSenderFixture(directory, binding)).status, "active-or-interrupted");
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, ...binding, owner: "00000000-0000-4000-8000-000000000003", phase: "settled" }));
  assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
}));

test("v2 reservation bytes cannot be relabelled as tracked v3", async () => fixture(async directory => {
  const legacy = JSON.stringify({ version: 2, kind: "native-operation", owner, operation: "native.searchmedia" }) + "\n";
  const legacyId = createHash("sha256").update(legacy).digest("hex");
  await assert.rejects(startSenderFixture(directory, { ...binding, reservationId: legacyId, reservationBytes: legacy }, { command: process.execPath, args: ["-e", "process.exit(0)"] }).then(async running => { await running.closed; return running; }));
  assert.deepEqual(await readdir(directory), []);
}));

test("fixture identity cannot claim a different route or native reservation", async () => fixture(async directory => {
  await assert.rejects(startSenderFixture(directory, { ...binding, route: "materialization" }, { command: process.execPath, args: ["-e", "process.exit(0)"] }).then(async running => { await running.closed; return running; }));
  const nativeBytes = JSON.stringify({ version: 3, kind: "native-operation", owner, operation: "native.searchmedia", senderTracked: true }) + "\n";
  const nativeId = createHash("sha256").update(nativeBytes).digest("hex");
  await assert.rejects(startSenderFixture(directory, { ...binding, reservationBytes: nativeBytes, reservationId: nativeId }, { command: process.execPath, args: ["-e", "process.exit(0)"] }).then(async running => { await running.closed; return running; }));
  assert.deepEqual(await readdir(directory), []);
}));

test("fixture supports a distinct synthetic v4 intent without migrating it", async () => fixture(async directory => {
  const reservationBytes = JSON.stringify({ version: 4, kind: "native-operation", owner, operation: "fixture.materialization", senderTracked: true }) + "\n";
  const input = { ...binding, reservationVersion: 4 as const, route: "materialization" as const, reservationBytes, reservationId: createHash("sha256").update(reservationBytes).digest("hex") };
  const running = await startSenderFixture(directory, input, { command: process.execPath, args: ["-e", "process.exit(0)"] });
  await running.closed;
  assert.equal((await inspectSenderFixture(directory, input)).status, "sender-settled");
  assert.equal((await inspectSenderFixture(directory, { ...input, reservationVersion: 3 })).status, "unknown");
}));

test("changed marker owner cannot create trusted lifecycle evidence", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild], killAfterMs: 200 });
  try {
    await once(running.child.stdout!, "data");
    const start = join(directory, `${id}.sender-start`);
    const value = JSON.parse(await readFile(start, "utf8"));
    value.owner = "00000000-0000-4000-8000-000000000003";
    await writeFile(start, JSON.stringify(value));
    await assert.rejects(running.abort(), /OWNER_MISMATCH/);
    await running.closed;
    assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
    assert.equal(running.localStatus(), "unknown");
  } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
}));


test("unexpected settlement marker fields are unknown", async () => fixture(async directory => {
  const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", "process.exit(0)"] });
  await running.closed;
  const path = join(directory, `${id}.sender-settled`);
  const marker = JSON.parse(await readFile(path, "utf8"));
  marker.pid = process.pid;
  await writeFile(path, JSON.stringify(marker));
  assert.equal((await inspectSenderFixture(directory, binding)).status, "unknown");
}));

test("intent owner must match binding owner before any side effects", async () => fixture(async directory => {
  const otherOwner = "00000000-0000-4000-8000-000000000003";
  await assert.rejects(startSenderFixture(directory, { ...binding, owner: otherOwner }, { command: process.execPath, args: ["-e", "process.exit(0)"] }).then(async running => { await running.closed; return running; }), /INVALID_BINDING/);
  assert.equal((await inspectSenderFixture(directory, { ...binding, owner: otherOwner })).status, "unknown");
  assert.deepEqual(await readdir(directory), []);
}));

test("marker recheck distinguishes absence from JSON null and changed bytes", async () => {
  for (const phase of ["abort", "settled"] as const) await fixture(async directory => {
    const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
    try {
      await once(running.child.stdout!, "data");
      const observed = await inspectSenderFixture(directory, binding, { beforeRecheck: async () => {
        await writeFile(join(directory, `${id}.sender-${phase}`), "null");
      } });
      assert.equal(observed.status, "unknown", phase);
    } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
  });
  await fixture(async directory => {
    const running = await startSenderFixture(directory, binding, { command: process.execPath, args: ["-e", delayedChild] });
    try {
      await once(running.child.stdout!, "data");
      const path = join(directory, `${id}.sender-start`);
      const observed = await inspectSenderFixture(directory, binding, { beforeRecheck: async () => {
        await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, "utf8")), null, 2));
      } });
      assert.equal(observed.status, "unknown");
    } finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL"); await running.closed; }
  });
});
