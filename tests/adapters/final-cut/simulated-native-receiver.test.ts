import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ScriptedNativeReceiver } from "../../support/simulated-native-receiver.js";

const request = {
  operationId: "operation-1", targetId: "target-1", sourceDigest: "a".repeat(64), desiredDigest: "c".repeat(64), revisionId: "revision-1",
};

test("simulated-native: simulation records deterministic identity and ordered dispatch events", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "accept" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "accepted" });
  assert.deepEqual(receiver.trace(), [
    { tick: 1, kind: "dispatch", ...request },
    { tick: 2, kind: "accepted", ...request },
  ]);
  assert.equal(receiver.evidenceTier, "simulated-native");
});

test("simulated-native: lost responses remain uncertain across restart and duplicate delivery", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "uncertain" });
  const restarted = receiver.restart();
  assert.deepEqual(await restarted.dispatch(request), { state: "uncertain" });
  assert.equal(restarted.trace().filter(event => event.kind === "dispatch").length, 1);
  await assert.rejects(restarted.dispatch({ ...request, targetId: "other" }), /IDENTITY_MISMATCH/);
});

test("simulated-native: stalled requests and late replies are explicitly controlled", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "stall" }]);
  const pending = receiver.dispatch(request);
  assert.deepEqual(receiver.trace().map(event => event.kind), ["dispatch", "stalled"]);
  receiver.reply(request.operationId, "rejected");
  assert.deepEqual(await pending, { state: "rejected" });
  assert.deepEqual(receiver.trace().map(event => event.kind), ["dispatch", "stalled", "rejected"]);
});

test("simulated-native: disconnect before dispatch records no receiver action", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "disconnect-before-dispatch" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "not-dispatched" });
  assert.deepEqual(receiver.trace().map(event => event.kind), ["disconnected"]);
  assert.deepEqual(receiver.restart().inspect(request.operationId), { state: "not-dispatched" });
});

test("simulated-native: duplicate operation identities reject changed source and revision", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  await receiver.dispatch(request);
  await assert.rejects(receiver.dispatch({ ...request, sourceDigest: "b".repeat(64) }), /IDENTITY_MISMATCH/);
  await assert.rejects(receiver.dispatch({ ...request, revisionId: "revision-2" }), /IDENTITY_MISMATCH/);
  assert.equal(receiver.trace().filter(event => event.kind === "dispatch").length, 1);
});

test("simulated-native: a lost response can arrive late without another dispatch", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "uncertain" });
  receiver.reply(request.operationId, "accepted");
  assert.deepEqual(receiver.inspect(request.operationId), { state: "accepted" });
  assert.equal(receiver.trace().filter(event => event.kind === "dispatch").length, 1);
});

test("simulated-native: serialized receiver state restores without replaying dispatch", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  await receiver.dispatch(request);
  const persisted = JSON.stringify(receiver.snapshot());
  const restored = ScriptedNativeReceiver.restore(JSON.parse(persisted));
  assert.deepEqual(restored.inspect(request.operationId), { state: "uncertain" });
  assert.deepEqual(await restored.dispatch(request), { state: "uncertain" });
  assert.deepEqual(restored.trace().map(event => event.kind), ["dispatch", "response-lost"]);
  restored.reply(request.operationId, "accepted");
  assert.equal(restored.trace().filter(event => event.kind === "dispatch").length, 1);
});

test("simulated-native: restoring a stalled receiver does not invent a terminal outcome", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "stall" }]);
  const pending = receiver.dispatch(request);
  const restored = ScriptedNativeReceiver.restore(JSON.parse(JSON.stringify(receiver.snapshot())));
  assert.deepEqual(restored.inspect(request.operationId), { state: "uncertain" });
  assert.deepEqual(await restored.dispatch(request), { state: "uncertain" });
  restored.reply(request.operationId, "rejected");
  assert.deepEqual(restored.inspect(request.operationId), { state: "rejected" });
  receiver.reply(request.operationId, "rejected");
  await pending;
});


test("simulated-native: a separate process restores uncertainty without dispatching again", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  await receiver.dispatch(request);
  const script = `import { ScriptedNativeReceiver } from "./tests/support/simulated-native-receiver.ts";
    const data = JSON.parse(await new Promise(resolve => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => resolve(text)); }));
    const receiver = ScriptedNativeReceiver.restore(data.snapshot);
    const result = await receiver.dispatch(data.request);
    process.stdout.write(JSON.stringify({ result, trace: receiver.trace() }));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { input: JSON.stringify({ snapshot: receiver.snapshot(), request }), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.result.state, "uncertain");
  assert.deepEqual(observed.trace.map((event: { kind: string }) => event.kind), ["dispatch", "response-lost"]);
});

test("simulated-native: evidence binds candidate and redacts identifiers", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  await receiver.dispatch({ ...request, targetId: "/private/example.mov" });
  const evidence = receiver.evidence({ scenario: "lost-reply", seed: 42, candidate: "a".repeat(40) });
  assert.equal(evidence.tier, "simulated-native");
  assert.equal(evidence.candidate, "a".repeat(40));
  assert.equal(evidence.scenario, "lost-reply");
  assert.equal(evidence.seed, 42);
  assert.deepEqual(evidence.events.map(event => event.kind), ["dispatch", "response-lost"]);
  assert.match(evidence.events[0].targetId, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /private|example\.mov/);
  assert.throws(() => receiver.evidence({ scenario: "lost-reply", seed: 42, candidate: "unknown" }), /CANDIDATE/);
});

test("simulated-native: partial writes remain distinct from acceptance", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "partial-write" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "partial" });
  assert.deepEqual(receiver.trace().map(event => event.kind), ["dispatch", "partial"]);
  assert.deepEqual(await receiver.dispatch(request), { state: "partial" });
});
