import assert from "node:assert/strict";
import test from "node:test";
import { ScriptedNativeReceiver } from "../../support/simulated-native-receiver.js";

const request = {
  operationId: "operation-1", targetId: "target-1", sourceDigest: "a".repeat(64), desiredDigest: "c".repeat(64), revisionId: "revision-1",
};

test("simulation records deterministic identity and ordered dispatch events", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "accept" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "accepted" });
  assert.deepEqual(receiver.trace(), [
    { tick: 1, kind: "dispatch", ...request },
    { tick: 2, kind: "accepted", ...request },
  ]);
  assert.equal(receiver.evidenceTier, "simulated-native");
});

test("lost responses remain uncertain across restart and duplicate delivery", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "uncertain" });
  const restarted = receiver.restart();
  assert.deepEqual(await restarted.dispatch(request), { state: "uncertain" });
  assert.equal(restarted.trace().filter(event => event.kind === "dispatch").length, 1);
  await assert.rejects(restarted.dispatch({ ...request, targetId: "other" }), /IDENTITY_MISMATCH/);
});

test("stalled requests and late replies are explicitly controlled", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "stall" }]);
  const pending = receiver.dispatch(request);
  assert.deepEqual(receiver.trace().map(event => event.kind), ["dispatch", "stalled"]);
  receiver.reply(request.operationId, "rejected");
  assert.deepEqual(await pending, { state: "rejected" });
  assert.deepEqual(receiver.trace().map(event => event.kind), ["dispatch", "stalled", "rejected"]);
});

test("disconnect before dispatch records no receiver action", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "disconnect-before-dispatch" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "not-dispatched" });
  assert.deepEqual(receiver.trace().map(event => event.kind), ["disconnected"]);
  assert.deepEqual(receiver.restart().inspect(request.operationId), { state: "not-dispatched" });
});

test("duplicate operation identities reject changed source and revision", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  await receiver.dispatch(request);
  await assert.rejects(receiver.dispatch({ ...request, sourceDigest: "b".repeat(64) }), /IDENTITY_MISMATCH/);
  await assert.rejects(receiver.dispatch({ ...request, revisionId: "revision-2" }), /IDENTITY_MISMATCH/);
  assert.equal(receiver.trace().filter(event => event.kind === "dispatch").length, 1);
});

test("a lost response can arrive late without another dispatch", async () => {
  const receiver = new ScriptedNativeReceiver([{ kind: "lose-response" }]);
  assert.deepEqual(await receiver.dispatch(request), { state: "uncertain" });
  receiver.reply(request.operationId, "accepted");
  assert.deepEqual(receiver.inspect(request.operationId), { state: "accepted" });
  assert.equal(receiver.trace().filter(event => event.kind === "dispatch").length, 1);
});
