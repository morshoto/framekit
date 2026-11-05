import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspectNativeRecoveryReadOnly, type NativePublishRecoveryContext } from "../../adapters/final-cut/typescript/src/native-recovery-inspection.js";
import { FileCanonicalRecoveryGuard } from "../../adapters/final-cut/typescript/src/canonical-recovery-guard.js";

const owner = "00000000-0000-4000-8000-000000000001";
const jobId = "publish-job-123";
const dispatchId = "00000000-0000-4000-8000-000000000002";
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const operation = `native.publish.${digest(jobId)}`;
const v2 = () => ({ version: 2, kind: "native-operation", owner, operation: "native.searchmedia" });
const v3 = (): { version: 3; kind: string; owner: string; operation: string; senderTracked: boolean; recoveryContext: NativePublishRecoveryContext } => ({ version: 3, kind: "native-operation", owner, operation, senderTracked: true, recoveryContext: {
  kind: "publish", jobId, dispatchId, requestedTarget: { libraryPath: "/tmp/target.fcpbundle" }, artifactDigest: "a".repeat(64), executorIdentity: null, nativeQuiescence: "unproven" } });
const v4 = () => ({ ...v3(), version: 4, recoveryContext: { ...v3().recoveryContext, executorIdentity: "receiver-1", dispatchState: "intent", canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) } });

test("durable publish intent survives restart as uncertain, never as receiver completion", async () => fixture(async (path) => {
  const context = v3().recoveryContext;
  const original = new FileCanonicalRecoveryGuard(path);
  const reservation = await original.beginNative(operation, context);
  const restarted = new FileCanonicalRecoveryGuard(path);
  const evidence = await restarted.inspectNativeRecoveryEvidence();
  assert.equal(evidence.reservation?.reservationId, reservation.reservationId);
  assert.equal(evidence.reservation?.jobId, jobId);
  assert.equal(evidence.reservation?.dispatchId, dispatchId);
  assert.equal(evidence.nativeQuiescence, "unproven");
  assert.equal(evidence.recoveryEligibility, "unavailable");
  assert.equal(evidence.dispatchState, "possibly-dispatched");
  assert.deepEqual(evidence.missingEvidence, ["receiver-terminal-quiescence", "independent-target-outcome", "legacy-writer-exclusion"]);
  assert.deepEqual(evidence.safeNextActions, ["inspect", "retain-reservation"]);
  assert.equal(evidence.intent?.artifactDigest, context.artifactDigest);
  assert.deepEqual(evidence.intent?.requestedTarget, context.requestedTarget);
  await assert.rejects(restarted.beginNative(operation, context), /RECOVERY_REQUIRED/);
  await assert.rejects(restarted.assertClear(), /RECOVERY_REQUIRED/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).recoveryContext, context);
}));

test("reservation rejects a mismatched operation before creating durable intent", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  await assert.rejects(guard.beginNative("native.publish.other", v3().recoveryContext), /INVALID_OPERATION/);
  assert.equal((await inspectNativeRecoveryReadOnly(path)).status, "clear");
}));

test("durable dispatch boundary forbids owner release and survives restart", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  const reservation = await guard.beginNative(operation, v3().recoveryContext);
  await reservation.markDispatchPossible();
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
  const restarted = new FileCanonicalRecoveryGuard(path);
  const evidence = await restarted.inspectNativeRecoveryEvidence();
  assert.equal(evidence.reservation?.reservationId, reservation.reservationId);
  assert.equal(evidence.dispatchState, "possibly-dispatched");
  assert.equal(evidence.boundaryEvidence, "dispatch-possible-recorded");
  assert.equal(evidence.recoveryEligibility, "unavailable");
  await assert.rejects(restarted.beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
}));

test("release cannot race a dispatch boundary on the same owner", async () => fixture(async (path) => {
  const reservation = await new FileCanonicalRecoveryGuard(path).beginNative(operation, v3().recoveryContext);
  const releasing = reservation.release();
  await assert.rejects(reservation.markDispatchPossible(), /RECOVERY_REQUIRED/);
  await releasing;
}));

test("a sender crash after durable intent remains uncertain across repeated inspections", async () => fixture(async (path) => {
  const module = pathToFileURL(resolve("adapters/final-cut/typescript/src/canonical-recovery-guard.ts")).href;
  const context = JSON.stringify(v3().recoveryContext);
  const script = `import {FileCanonicalRecoveryGuard} from ${JSON.stringify(module)}; await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative(${JSON.stringify(operation)}, ${context}); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { timeout: 5000 });
  assert.equal(child.signal, "SIGKILL");
  const before = await readFile(path, "utf8");
  for (let attempt = 0; attempt < 2; attempt++) {
    const restarted = new FileCanonicalRecoveryGuard(path);
    const evidence = await restarted.inspectNativeRecoveryEvidence();
    assert.equal(evidence.dispatchState, "possibly-dispatched");
    assert.equal(evidence.recoveryEligibility, "unavailable");
    await assert.rejects(restarted.beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
    assert.equal(await readFile(path, "utf8"), before);
  }
}));

test("a crash during reservation creation remains unknown and blocks a new writer", async () => fixture(async (path) => {
  const script = "require('fs').closeSync(require('fs').openSync(process.argv[1], 'wx')); process.kill(process.pid, 'SIGKILL');";
  const child = spawnSync(process.execPath, ["-e", script, path], { timeout: 5000 });
  assert.equal(child.signal, "SIGKILL");
  const guard = new FileCanonicalRecoveryGuard(path);
  assert.equal((await guard.inspectNativeRecoveryEvidence()).status, "unknown");
  await assert.rejects(guard.beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), "");
}));

test("a legacy reservation excludes a new intent writer", async () => fixture(async (path) => {
  const legacy = JSON.stringify(v2()) + "\n";
  const child = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx'});", path, legacy], { timeout: 5000 });
  assert.equal(child.status, 0);
  await assert.rejects(new FileCanonicalRecoveryGuard(path).beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), legacy);
}));

async function snapshot(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { found[`${name}/`] = "directory"; await walk(join(path, entry.name), `${name}/`); }
      else found[name] = digest(await readFile(join(path, entry.name)));
    }
  }
  await walk(directory, "");
  return found;
}

async function fixture(run: (path: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "framekit-readonly-inspect-"));
  try { await run(join(directory, "pending.json"), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function put(path: string, data: unknown) {
  const contents = JSON.stringify(data) + "\n";
  await writeFile(path, contents);
  return digest(contents);
}

async function unchanged<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const before = await snapshot(directory);
  const result = await action();
  assert.deepEqual(await snapshot(directory), before);
  return result;
}

test("absence is a point-in-time observation with no recovery eligibility", async () => fixture(async (path, directory) => {
  const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
  assert.equal(result.status, "clear");
  assert.equal(result.recoveryEligibility, "unavailable");
  assert.equal(result.nativeQuiescence, "unproven");
}));

test("legacy v2 reservation is identified without invented job or sender state", async () => fixture(async (path, directory) => {
  const id = await put(path, v2());
  const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
  assert.deepEqual(result.reservation, { version: 2, reservationId: id, operation: "native.searchmedia" });
  assert.equal(result.status, "recovery-required");
  assert.equal(result.sender.status, "untracked");
  assert.equal(result.recoveryEligibility, "unavailable");
}));

test("v3 and v4 retain their version and validated operation and job identity", async () => fixture(async (path, directory) => {
  for (const record of [v3(), v4()]) {
    const id = await put(path, record);
    const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
    assert.deepEqual(result.reservation, { version: record.version, reservationId: id, operation, jobId, dispatchId, jobCorrelation: "unverified" });
    assert.equal(result.status, "recovery-required");
    assert.equal(result.sender.status, "unknown");
    assert.equal(result.recoveryEligibility, "unavailable");
  }
}));

test("corrupt, incomplete and mismatched evidence remains unknown", async () => fixture(async (path, directory) => {
  for (const record of ["{", JSON.stringify({ ...v3(), recoveryContext: {} }), JSON.stringify({ ...v3(), operation: "native.publish.wrong" }), JSON.stringify({ ...v4(), recoveryContext: { ...v4().recoveryContext, canonicalTarget: {} } })]) {
    await writeFile(path, record);
    const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
    assert.equal(result.status, "unknown");
    assert.equal(result.recoveryEligibility, "unavailable");
    assert.equal(result.nativeQuiescence, "unproven");
  }
}));

test("sender activity and settlement are evidence only and mismatches stay unknown", async () => fixture(async (path, directory) => {
  const id = await put(path, v3());
  const marker = JSON.stringify({ reservationId: id, owner }) + "\n";
  await writeFile(`${path}.active`, marker);
  assert.equal((await unchanged(directory, () => inspectNativeRecoveryReadOnly(path))).sender.status, "active-or-interrupted");
  await rm(`${path}.active`);
  await mkdir(`${path}.sender-settled`);
  await writeFile(join(`${path}.sender-settled`, id), marker);
  const settled = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
  assert.equal(settled.sender.status, "sender-settled");
  assert.equal(settled.nativeQuiescence, "unproven");
  assert.equal(settled.recoveryEligibility, "unavailable");
  await writeFile(join(`${path}.sender-settled`, id), JSON.stringify({ reservationId: "f".repeat(64), owner }));
  assert.equal((await unchanged(directory, () => inspectNativeRecoveryReadOnly(path))).sender.status, "unknown");
}));

test("a crashed lock and a legacy writer coexist without inspection modifying either", async () => fixture(async (path, directory) => {
  const crashed = spawnSync(process.execPath, ["-e", "require('fs').mkdirSync(process.argv[1]); process.kill(process.pid, 'SIGKILL');", `${path}.lock`], { timeout: 10000 });
  assert.equal(crashed.signal, "SIGKILL");
  const legacy = JSON.stringify(v2()) + "\n";
  const writer = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx'});", path, legacy], { timeout: 10000 });
  assert.equal(writer.status, 0);
  const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
  assert.equal(result.status, "unknown");
  assert.equal(result.recoveryEligibility, "unavailable");
}));

test("concurrent processes inspect the same reservation without state changes", async () => fixture(async (path, directory) => {
  const id = await put(path, v2());
  const module = pathToFileURL(resolve("adapters/final-cut/typescript/src/native-recovery-inspection.ts")).href;
  const script = `import {inspectNativeRecoveryReadOnly} from ${JSON.stringify(module)}; console.log(JSON.stringify(await inspectNativeRecoveryReadOnly(process.argv[1])));`;
  const inspect = () => new Promise<any>((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { if (code !== 0) reject(new Error(stderr)); else resolveResult(JSON.parse(stdout)); });
  });
  const results = await unchanged(directory, () => Promise.all([inspect(), inspect(), inspect()]));
  assert.ok(results.every(result => result.reservation?.reservationId === id && result.status === "recovery-required"));
}));

test("materialization evidence binds a job to its operation without treating intent as completion", async () => fixture(async (path, directory) => {
  const materializationJob = "materialization-123";
  const materializationOperation = `native.materialize.${digest(materializationJob)}`;
  const target = { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" };
  const context = { kind: "materialization", jobId: materializationJob, dispatchId, requestedTarget: target, artifactDigest: "a".repeat(64), desiredDigest: "b".repeat(64), executorIdentity: null, nativeQuiescence: "unproven" };
  const id = await put(path, { version: 3, kind: "native-operation", owner, operation: materializationOperation, recoveryContext: context });
  const result = await unchanged(directory, () => inspectNativeRecoveryReadOnly(path));
  assert.deepEqual(result.reservation, { version: 3, reservationId: id, operation: materializationOperation, jobId: materializationJob, dispatchId, jobCorrelation: "unverified" });
  assert.equal(result.nativeQuiescence, "unproven");
  assert.equal(result.recoveryEligibility, "unavailable");
}));

test("a materialization reservation with a non-versioned destination remains unknown", async () => fixture(async (path) => {
  const materializationJob = "materialization-123";
  const record = { version: 3, kind: "native-operation", owner,
    operation: `native.materialize.${digest(materializationJob)}`,
    recoveryContext: { kind: "materialization", jobId: materializationJob, dispatchId,
      requestedTarget: { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" },
      artifactDigest: "a".repeat(64), desiredDigest: "b".repeat(64), executorIdentity: null, nativeQuiescence: "unproven",
      destination: { mode: "reuse-existing", projectUid: "project", sequenceUid: "sequence", projectName: "Project", sequenceName: "Main" } } };
  await put(path, record);
  assert.equal((await inspectNativeRecoveryReadOnly(path)).status, "unknown");
}));

test("special files cannot block inspection or change state", async () => fixture(async (path, directory) => {
  const made = spawnSync("mkfifo", [path], { timeout: 5000 });
  assert.equal(made.status, 0);
  const before = await readdir(directory);
  const module = pathToFileURL(resolve("adapters/final-cut/typescript/src/native-recovery-inspection.ts")).href;
  const script = `import {inspectNativeRecoveryReadOnly} from ${JSON.stringify(module)}; console.log(JSON.stringify(await inspectNativeRecoveryReadOnly(process.argv[1])));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { encoding: "utf8", timeout: 1500 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.equal(JSON.parse(child.stdout).status, "unknown");
  assert.deepEqual(await readdir(directory), before);
}));

test("live new lock holder cannot exclude a separate legacy writer", async () => fixture(async (path, directory) => {
  const script = "require('fs').mkdirSync(process.argv[1]); console.log('locked'); process.stdin.resume();";
  const holder = spawn(process.execPath, ["-e", script, `${path}.lock`]);
  const closed = new Promise<void>(resolveExit => holder.once("close", () => resolveExit()));
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder did not start")), 5000);
      holder.once("error", error => { clearTimeout(timer); reject(error); });
      holder.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
      holder.once("exit", () => { clearTimeout(timer); reject(new Error("lock holder exited early")); });
    });
    const legacy = JSON.stringify(v2()) + "\n";
    const writer = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx'});", path, legacy], { timeout: 5000 });
    assert.equal(writer.status, 0);
    assert.equal((await unchanged(directory, () => inspectNativeRecoveryReadOnly(path))).status, "unknown");
    assert.equal(await readFile(path, "utf8"), legacy);
  } finally {
    holder.kill("SIGKILL");
    await closed;
  }
}));

test("an empty sender marker on a legacy reservation remains unknown", async () => fixture(async (path, directory) => {
  const id = await put(path, v2());
  await writeFile(`${path}.active`, "");
  assert.equal((await unchanged(directory, () => inspectNativeRecoveryReadOnly(path))).sender.status, "unknown");
  await rm(`${path}.active`);
  await mkdir(`${path}.sender-settled`);
  await writeFile(join(`${path}.sender-settled`, id), "");
  assert.equal((await unchanged(directory, () => inspectNativeRecoveryReadOnly(path))).sender.status, "unknown");
}));

test("sender crash after the durable dispatch marker retains uncertainty after restart", async () => fixture(async (path) => {
  const module = pathToFileURL(resolve("adapters/final-cut/typescript/src/canonical-recovery-guard.ts")).href;
  const context = JSON.stringify(v3().recoveryContext);
  const script = `import {FileCanonicalRecoveryGuard} from ${JSON.stringify(module)}; const handle = await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative(${JSON.stringify(operation)}, ${context}); await handle.markDispatchPossible(); process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { timeout: 5000 });
  assert.equal(child.signal, "SIGKILL");
  const restarted = new FileCanonicalRecoveryGuard(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await restarted.inspectNativeRecoveryEvidence();
    assert.equal(evidence.boundaryEvidence, "dispatch-possible-recorded");
    assert.equal(evidence.dispatchState, "possibly-dispatched");
    assert.equal(evidence.recoveryEligibility, "unavailable");
    await assert.rejects(restarted.beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
  }
}));


test("sender killed during simulated dispatch leaves a retained reservation", async () => fixture(async (path) => {
  const module = pathToFileURL(resolve("adapters/final-cut/typescript/src/canonical-recovery-guard.ts")).href;
  const context = JSON.stringify(v3().recoveryContext);
  const script = `import {FileCanonicalRecoveryGuard} from ${JSON.stringify(module)}; const handle = await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative(${JSON.stringify(operation)}, ${context}); await handle.markDispatchPossible(); process.stdout.write('dispatch-entered\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("simulated dispatch did not start")); }, 5000);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("dispatch-entered\n")) child.kill("SIGKILL");
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (_code, exitSignal) => { clearTimeout(timeout); resolve(exitSignal); });
    });
    assert.equal(signal, "SIGKILL");
    const restarted = new FileCanonicalRecoveryGuard(path);
    const evidence = await restarted.inspectNativeRecoveryEvidence();
    assert.equal(evidence.boundaryEvidence, "dispatch-possible-recorded");
    assert.equal(evidence.dispatchState, "possibly-dispatched");
    assert.equal(evidence.recoveryEligibility, "unavailable");
    await assert.rejects(restarted.beginNative(operation, v3().recoveryContext), /RECOVERY_REQUIRED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}));

test("uncertain reservation can durably bind a requested publish intent", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  const reservation = await guard.beginNative(operation);
  const initialId = reservation.reservationId;
  await reservation.markDispatchPossible();
  await reservation.bindRecoveryContext(v3().recoveryContext);
  assert.notEqual(reservation.reservationId, initialId);
  const restarted = new FileCanonicalRecoveryGuard(path);
  const observed = await restarted.inspectNativeRecoveryEvidence();
  assert.equal(observed.reservation?.version, 3);
  assert.equal(observed.reservation?.reservationId, reservation.reservationId);
  assert.equal(observed.reservation?.jobId, jobId);
  assert.equal(observed.intent?.artifactDigest, "a".repeat(64));
  assert.equal(observed.boundaryEvidence, "dispatch-possible-recorded");
  assert.equal(observed.dispatchState, "possibly-dispatched");
  assert.equal(observed.recoveryEligibility, "unavailable");
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
  await assert.rejects(reservation.bindRecoveryContext(v3().recoveryContext), /RECOVERY_REQUIRED/);
}));

test("intent cannot be bound before the uncertainty boundary", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  const reservation = await guard.beginNative(operation);
  await assert.rejects(reservation.bindRecoveryContext(v3().recoveryContext), /RECOVERY_REQUIRED/);
  await reservation.release();
  await guard.assertClear();
}));

test("failed intent binding retains the original uncertain reservation", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  const reservation = await guard.beginNative(operation);
  await reservation.markDispatchPossible();
  const original = await readFile(path, "utf8");
  const record = JSON.parse(original) as { owner: string };
  const next = JSON.stringify({ version: 3, kind: "native-operation", owner: record.owner, operation, recoveryContext: v3().recoveryContext }) + "\n";
  await mkdir(`${path}.dispatch-${digest(next)}`);
  await assert.rejects(reservation.bindRecoveryContext(v3().recoveryContext), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
  const observed = await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence();
  assert.equal(observed.reservation?.version, 2);
  assert.equal(observed.boundaryEvidence, "dispatch-possible-recorded");
  assert.equal(observed.recoveryEligibility, "unavailable");
}));

test("mismatched intent binding does not release or alter an uncertain reservation", async () => fixture(async (path) => {
  const guard = new FileCanonicalRecoveryGuard(path);
  const reservation = await guard.beginNative(operation);
  await reservation.markDispatchPossible();
  const original = await readFile(path, "utf8");
  await assert.rejects(reservation.bindRecoveryContext({ ...v3().recoveryContext, jobId: "publish-job-other" }), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
}));

test("intent binding refuses a replacement reservation", async () => fixture(async (path) => {
  const first = await new FileCanonicalRecoveryGuard(path).beginNative(operation);
  await first.markDispatchPossible();
  await rm(path);
  const replacement = await new FileCanonicalRecoveryGuard(path).beginNative(operation);
  const before = await readFile(path, "utf8");
  await assert.rejects(first.bindRecoveryContext(v3().recoveryContext), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), before);
  const observed = await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence();
  assert.equal(observed.reservation?.reservationId, replacement.reservationId);
  await assert.rejects(first.release(), /RECOVERY_REQUIRED/);
  await replacement.release();
}));

test("concurrent intent binding permits at most one attempt", async () => fixture(async (path) => {
  const reservation = await new FileCanonicalRecoveryGuard(path).beginNative(operation);
  await reservation.markDispatchPossible();
  const first = reservation.bindRecoveryContext(v3().recoveryContext);
  await assert.rejects(reservation.bindRecoveryContext(v3().recoveryContext), /RECOVERY_REQUIRED/);
  await first;
  assert.equal((await new FileCanonicalRecoveryGuard(path).inspectNativeRecoveryEvidence()).reservation?.version, 3);
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
}));

test("a simulated interrupted intent rewrite remains unknown and blocks new writers", async () => fixture(async (path) => {
  const reservation = await new FileCanonicalRecoveryGuard(path).beginNative(operation);
  await reservation.markDispatchPossible();
  const script = "const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'r+'); fs.writeSync(fd, '{\\\"version\\\":3', 0, 'utf8'); fs.ftruncateSync(fd, 12); fs.fsyncSync(fd); process.kill(process.pid, 'SIGKILL');";
  const child = spawnSync(process.execPath, ["-e", script, path], { timeout: 5000 });
  assert.equal(child.signal, "SIGKILL");
  const restarted = new FileCanonicalRecoveryGuard(path);
  assert.equal((await restarted.inspectNativeRecoveryEvidence()).status, "unknown");
  await assert.rejects(restarted.beginNative(operation), /RECOVERY_REQUIRED/);
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
}));

test("intent binding rejects a context that serializes to a different job", async () => fixture(async (path) => {
  const reservation = await new FileCanonicalRecoveryGuard(path).beginNative(operation);
  await reservation.markDispatchPossible();
  const before = await readFile(path, "utf8");
  const context = { ...v3().recoveryContext, toJSON() { return { ...v3().recoveryContext, jobId: "publish-job-other" }; } };
  await assert.rejects(reservation.bindRecoveryContext(context), /RECOVERY_REQUIRED/);
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(reservation.release(), /RECOVERY_REQUIRED/);
}));
