import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { FinalCutProjectPublisher } from "@framekit/final-cut";
import { createMcpServer } from "../../../apps/mcp-server/src/server.js";
import { bindQaAuthorization, claimDispatchIntent, createOrInspectRun, inspectRun, markDispatchUncertain } from "../../../scripts/native-qa/run-store.js";
import { runPublishStages } from "../../../scripts/final-cut-publisher-verification.mjs";
import { readQaEvidence, resumeHeadlessQaRun, startQaRun } from "../../../scripts/native-qa/supervisor.js";
import { publishQaRecord } from "../../../scripts/native-qa/atomic-record.js";
import { readQaArtifactEvidence, verifyQaArtifact } from "../../../scripts/native-qa/artifact-evidence.js";
import { inspectQaPublisher, inspectQaPublisherFromStore } from "../../../scripts/native-qa/publisher-inspection.js";
import { verifyQaPublisherFixture, readQaPublisherFixtureEvidence } from "../../../scripts/native-qa/publisher-fixture-evidence.js";
import { verifyQaPublisherSources, readQaPublisherSourceEvidence } from "../../../scripts/native-qa/publisher-source-evidence.js";
import { recordQaPublisherStage, readQaPublisherStages } from "../../../scripts/native-qa/publisher-stages.js";
import { runSupervisedQaPublisher } from "../../../scripts/native-qa/publisher-supervision.js";

const manifest = {
  qaRunId: "qa-fixture-1", candidateCommit: "a".repeat(40), candidateTree: "b".repeat(40),
  packageDigest: "1".repeat(64), mcpDigest: "8".repeat(64), pluginDigest: "2".repeat(64), extensionDigest: "3".repeat(64),
  artifactDigest: "4".repeat(64), sourceDigest: "5".repeat(64), targetDigest: "6".repeat(64),
  operation: "rough-cut-publish" as const, authorizationDigest: "7".repeat(64),
};

test("supervised publisher retains uncertain intent after a lost receiver response", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-supervised-publish-"));
  try {
    await createOrInspectRun(root, manifest);
    let dispatches = 0;
    const call = async (name: string) => {
      if (name === "artifact.publish.preview") return { jobId: "job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/library" };
      dispatches++;
      throw new Error("simulated lost response");
    };
    const input = { artifactPath: "/fixture/artifact", transactionId: "fixture", targetLibraryPath: "/fixture/library", artifactDigest: manifest.artifactDigest };
    await assert.rejects(runSupervisedQaPublisher(root, manifest, input, call, async () => {}), /PUBLISH_DISPATCH_UNCERTAIN/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.deepEqual((await readQaPublisherStages(root, manifest.qaRunId)).stages.map(value => value.stage), ["prepared"]);
    await assert.rejects(runSupervisedQaPublisher(root, manifest, input, call, async () => {}), /QA_DISPATCH_ALREADY_CLAIMED/);
    assert.equal(dispatches, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized QA records fail closed without weakening uncertain dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-oversized-"));
  try {
    await createOrInspectRun(root, manifest);
    const directory = join(root, manifest.qaRunId);
    const runPath = join(directory, "run.json");
    const original = await readFile(runPath, "utf8");
    await writeFile(runPath, original + " ".repeat(128 * 1024));
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_CORRUPT/);
    await writeFile(runPath, original);
    await writeFile(join(directory, "headless-started"), JSON.stringify({ schemaVersion: 1, startedAt: "2026-01-01T00:00:00.000Z" }) + " ".repeat(128 * 1024));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
    await writeFile(join(directory, "dispatch-uncertain"), JSON.stringify({ publishJobId: "job-1" }) + " ".repeat(128 * 1024));
    const uncertain = await inspectRun(root, manifest.qaRunId);
    assert.equal(uncertain.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(uncertain.publishJobId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized start manifest is rejected before a run is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-input-"));
  const input = join(root, "manifest.json");
  try {
    await writeFile(input, JSON.stringify(manifest) + " ".repeat(128 * 1024));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "start", root, input], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /QA_RECORD_INVALID/);
    await assert.rejects(lstat(join(root, manifest.qaRunId)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher source evidence binds four file identities and bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-source-evidence-"));
  const sources = await mkdtemp(join(tmpdir(), "framekit-qa-source-files-"));
  const names = [["a", "clip-a.mp4"], ["b", "clip-b.mp4"], ["c", "clip-c.mp4"], ["m", "generated-music.wav"]] as const;
  try {
    const entries = [];
    for (const [mediaId, name] of names) {
      const source = join(sources, name); const content = `synthetic-${mediaId}`;
      await writeFile(source, content);
      entries.push({ mediaId, source, sha256: createHash("sha256").update(content).digest("hex") });
    }
    const url = (name: string) => pathToFileURL(join(sources, name)).href;
    const xml = `<?xml version="1.0"?><fcpxml version="1.11"><resources><format id="f" frameDuration="1/24s" width="1280" height="720"/>
      <asset id="a" name="clip-a.mp4" src="${url("clip-a.mp4")}" duration="24s" hasVideo="1" format="f"/>
      <asset id="b" name="clip-b.mp4" src="${url("clip-b.mp4")}" duration="15s" hasVideo="1" format="f"/>
      <asset id="c" name="clip-c.mp4" src="${url("clip-c.mp4")}" duration="14s" hasVideo="1" format="f"/>
      <asset id="m" name="generated-music.wav" src="${url("generated-music.wav")}" duration="30s" hasAudio="1"/>
      <effect id="t" name="Basic Title" uid="basic"/></resources><library><event><project uid="p" name="Fixture"><sequence format="f" duration="30s"><spine>
      <asset-clip ref="b" offset="0s" start="5s" duration="8s"><title ref="t" lane="1" offset="5s" duration="6s"><text>FrameKit MVP Test</text></title><asset-clip ref="m" lane="1" audioRole="music" offset="5s" start="0s" duration="30s"><adjust-volume amount="-12dB"/></asset-clip></asset-clip>
      <asset-clip ref="a" offset="8s" start="10s" duration="12s"/><asset-clip ref="c" offset="20s" start="2s" duration="10s"/>
      </spine></sequence></project></event></library></fcpxml>`;
    const artifact = join(sources, "fixture.fcpxml"); await writeFile(artifact, xml);
    const bound = { ...manifest, artifactDigest: createHash("sha256").update(xml).digest("hex"),
      sourceDigest: createHash("sha256").update(JSON.stringify({ profile: "publisher-e2e-v1", sources: entries })).digest("hex") };
    await createOrInspectRun(root, bound);
    const evidence = await verifyQaPublisherSources(root, bound.qaRunId, artifact);
    assert.equal(evidence.sourceDigest, bound.sourceDigest);
    assert.equal(evidence.result, "matched"); assert.equal(evidence.scope, "snapshot-only");
    assert.equal(evidence.dispatchAllowed, false); assert.equal(evidence.nativeQuiescence, "unproven");
    assert.equal(JSON.stringify(evidence).includes(sources), false);
    assert.deepEqual(await readQaPublisherSourceEvidence(root, bound.qaRunId), evidence);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "publisher-source-evidence", root, bound.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), evidence);
    const verifyCli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "verify-publisher-sources", root, bound.qaRunId, artifact], { encoding: "utf8", timeout: 10000 });
    assert.equal(verifyCli.status, 0, verifyCli.stderr);
    assert.deepEqual(JSON.parse(verifyCli.stdout), evidence);
    await writeFile(entries[0]!.source, "replaced bytes");
    await assert.rejects(verifyQaPublisherSources(root, bound.qaRunId, artifact), /QA_SOURCE_DIGEST_MISMATCH/);
    await rm(entries[0]!.source);
    await assert.rejects(verifyQaPublisherSources(root, bound.qaRunId, artifact), /QA_SOURCE_UNSAFE/);
    await symlink(entries[1]!.source, entries[0]!.source);
    await assert.rejects(verifyQaPublisherSources(root, bound.qaRunId, artifact), /QA_SOURCE_UNSAFE/);
    await rm(entries[0]!.source);
    const { open } = await import("node:fs/promises");
    const oversized = await open(entries[0]!.source, "wx");
    try { await oversized.truncate(512 * 1024 * 1024 + 1); } finally { await oversized.close(); }
    await assert.rejects(verifyQaPublisherSources(root, bound.qaRunId, artifact), /QA_SOURCE_UNSAFE/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(sources, { recursive: true, force: true }); }
});

test("headless profile is bound to the original run across clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-profile-"));
  try {
    const fixture = { ...manifest, authorizationDigest: null };
    const first = await createOrInspectRun(root, fixture, "publisher-e2e-v1");
    assert.equal(first.run.headlessProfile, "publisher-e2e-v1");
    const duplicate = await createOrInspectRun(root, { ...fixture, qaRunId: "other-client" }, "publisher-e2e-v1");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, fixture.qaRunId);
    await assert.rejects(createOrInspectRun(root, fixture, "generic"), /QA_WORKER_PROFILE_MISMATCH/);
    await assert.rejects(createOrInspectRun(root, { ...fixture, qaRunId: "other-client" }, "generic"), /QA_WORKER_PROFILE_MISMATCH/);
    await assert.rejects(resumeHeadlessQaRun(root, fixture.qaRunId), /QA_WORKER_PROFILE_MISMATCH/);
    assert.equal((await inspectRun(root, fixture.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent profile claims cannot create different runs for the same job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-profile-race-"));
  try {
    const base = { ...manifest, authorizationDigest: null };
    const results = await Promise.allSettled([
      createOrInspectRun(root, { ...base, qaRunId: "generic-run" }, "generic"),
      createOrInspectRun(root, { ...base, qaRunId: "fixture-run" }, "publisher-e2e-v1"),
    ]);
    const winner = results.find(result => result.status === "fulfilled" && result.value.created);
    assert.ok(winner && winner.status === "fulfilled");
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.created).length, 1);
    const other = winner.value.run.headlessProfile === "generic" ? "publisher-e2e-v1" : "generic";
    await assert.rejects(createOrInspectRun(root, { ...base, qaRunId: "retry-client" }, other), /QA_WORKER_PROFILE_MISMATCH/);
    assert.equal(winner.value.run.dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy generic runs cannot be resumed as publisher fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-legacy-profile-"));
  try {
    const legacy = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, legacy);
    await assert.rejects(createOrInspectRun(root, legacy, "publisher-e2e-v1"), /QA_WORKER_PROFILE_MISMATCH/);
    await assert.rejects(resumeHeadlessQaRun(root, legacy.qaRunId, join(root, "fixture.fcpxml"), { publisherFixture: true }), /QA_WORKER_PROFILE_MISMATCH/);
    assert.equal((await inspectRun(root, legacy.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker rejects input that changes the recorded profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-worker-profile-"));
  try {
    const bound = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, bound, "publisher-e2e-v1");
    const worker = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/worker.ts", root, bound.qaRunId], { input: "{}", encoding: "utf8", timeout: 10000 });
    assert.notEqual(worker.status, 0);
    assert.match(worker.stderr, /QA_WORKER_PROFILE_MISMATCH/);
    await assert.rejects(lstat(join(root, bound.qaRunId, "headless-started")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher fixture worker requires an explicit artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-fixture-worker-"));
  try {
    const input = join(root, "manifest.json");
    await writeFile(input, JSON.stringify({ ...manifest, authorizationDigest: null }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "start-publisher-fixture", root, input], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(result.status, 0);
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
    const artifact = join(root, "fixture.fcpxml"); await writeFile(artifact, "fixture");
    const start = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "start-publisher-fixture", root, input, artifact], { encoding: "utf8", timeout: 10000 });
    assert.equal(start.status, 0, start.stderr);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, manifest.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(await readQaPublisherFixtureEvidence(root, manifest.qaRunId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher fixture evidence binds the artifact bytes and expected edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-fixture-evidence-"));
  const artifacts = await mkdtemp(join(tmpdir(), "framekit-qa-fixture-artifacts-"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.11"><resources>
  <format id="f" frameDuration="1/24s" width="1280" height="720"/>
  <asset id="a" name="clip-a.mp4" src="file:///fixture/clip-a.mp4" duration="24s" hasVideo="1" format="f"/>
  <asset id="b" name="clip-b.mp4" src="file:///fixture/clip-b.mp4" duration="15s" hasVideo="1" format="f"/>
  <asset id="c" name="clip-c.mp4" src="file:///fixture/clip-c.mp4" duration="14s" hasVideo="1" format="f"/>
  <asset id="m" name="generated-music.wav" src="file:///fixture/generated-music.wav" duration="30s" hasAudio="1"/>
  <effect id="t" name="Basic Title" uid="basic"/></resources><library><event><project uid="p" name="Fixture"><sequence format="f" duration="30s"><spine>
  <asset-clip ref="b" offset="0s" start="5s" duration="8s"><title ref="t" lane="1" offset="5s" duration="6s"><text>FrameKit MVP Test</text></title><asset-clip ref="m" lane="1" audioRole="music" offset="5s" start="0s" duration="30s"><adjust-volume amount="-12dB"/></asset-clip></asset-clip>
  <asset-clip ref="a" offset="8s" start="10s" duration="12s"/><asset-clip ref="c" offset="20s" start="2s" duration="10s"/>
  </spine></sequence></project></event></library></fcpxml>`;
  try {
    const path = join(artifacts, "fixture.fcpxml");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(path, xml);
    const bound = { ...manifest, artifactDigest: digest(xml) };
    await createOrInspectRun(root, bound);
    const evidence = await verifyQaPublisherFixture(root, bound.qaRunId, path);
    assert.equal(evidence.result, "matched");
    assert.equal(evidence.artifactDigest, bound.artifactDigest);
    assert.equal(evidence.dispatchAllowed, false);
    assert.equal(evidence.nativeQuiescence, "unproven");
    assert.equal(JSON.stringify(evidence).includes(artifacts), false);
    assert.deepEqual(await readQaPublisherFixtureEvidence(root, bound.qaRunId), evidence);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "publisher-fixture-evidence", root, bound.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), evidence);
    const verifyCli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "verify-publisher-fixture", root, bound.qaRunId, path], { encoding: "utf8", timeout: 10000 });
    assert.equal(verifyCli.status, 0, verifyCli.stderr);
    assert.deepEqual(JSON.parse(verifyCli.stdout), evidence);
    await writeFile(path, xml.replace('start="5s" duration="8s"', 'start="4s" duration="8s"'));
    await assert.rejects(verifyQaPublisherFixture(root, bound.qaRunId, path), /QA_ARTIFACT_DIGEST_MISMATCH/);
    const altered = await readFile(path, "utf8");
    const changed = { ...manifest, qaRunId: "qa-fixture-changed", artifactDigest: digest(altered), authorizationDigest: "9".repeat(64) };
    await createOrInspectRun(root, changed);
    await assert.rejects(verifyQaPublisherFixture(root, changed.qaRunId, path), /QA_PUBLISH_FIXTURE_MISMATCH/);
    assert.equal(await readQaPublisherFixtureEvidence(root, changed.qaRunId), null);
    const linked = join(artifacts, "linked.fcpxml"); await symlink(path, linked);
    await assert.rejects(verifyQaPublisherFixture(root, changed.qaRunId, linked), /QA_ARTIFACT_UNSAFE/);
    await writeFile(join(root, bound.qaRunId, "publisher-fixture-evidence.json"), "{");
    await assert.rejects(readQaPublisherFixtureEvidence(root, bound.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
});

test("initial creation and identical restart are inspect-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    const first = await createOrInspectRun(root, manifest);
    assert.equal(first.created, true);
    assert.equal(first.run.dispatch, "NOT_DISPATCHED");
    assert.equal(first.run.verdict, "BLOCKED");
    const second = await createOrInspectRun(root, manifest);
    assert.equal(second.created, false);
    assert.deepEqual(second.run, first.run);
    assert.deepEqual(await inspectRun(root, manifest.qaRunId), first.run);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed candidate, target or authorization is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    await createOrInspectRun(root, manifest);
    for (const changed of [{ candidateCommit: "c".repeat(40) }, { targetDigest: "8".repeat(64) }, { mcpDigest: "9".repeat(64) }, { authorizationDigest: "9".repeat(64) }]) {
      await assert.rejects(createOrInspectRun(root, { ...manifest, ...changed }), /QA_RUN_IDENTITY_MISMATCH/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt state and invalid run identifiers fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-"));
  try {
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "../other" }), /QA_RUN_ID_INVALID/);
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "run.json"), "{");
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_CORRUPT/);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent identical starts create at most one record", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-race-"));
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => createOrInspectRun(root, manifest)));
    const created = attempts.filter(result => result.status === "fulfilled" && result.value.created);
    assert.equal(created.length, 1);
    for (const result of attempts) {
      if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
      else assert.equal(result.value.run.dispatch, "NOT_DISPATCHED");
    }
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete initialization is never treated as a new run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-incomplete-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, manifest.qaRunId));
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("linked run directories cannot masquerade as owned records", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-link-"));
  const other = await mkdtemp(join(tmpdir(), "framekit-qa-other-"));
  try {
    await createOrInspectRun(other, manifest);
    await symlink(join(other, manifest.qaRunId), join(root, manifest.qaRunId), "dir");
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_UNSAFE_PATH/);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_UNSAFE_PATH/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});


test("uncertain dispatch remains blocked across repeated starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-uncertain-"));
  try {
    await createOrInspectRun(root, manifest);
    const marked = await markDispatchUncertain(root, manifest);
    assert.equal(marked.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(marked.verdict, "BLOCKED");
    assert.deepEqual(await markDispatchUncertain(root, manifest), marked);
    const reopened = await createOrInspectRun(root, manifest);
    assert.equal(reopened.created, false);
    assert.deepEqual(reopened.run, marked);
    await assert.rejects(markDispatchUncertain(root, { ...manifest, targetDigest: "8".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an incomplete dispatch marker is never interpreted as safe to replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-marker-"));
  try {
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "dispatch-uncertain"), "");
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mismatched identity cannot mark an existing run uncertain", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mismatch-"));
  try {
    await createOrInspectRun(root, manifest);
    await assert.rejects(markDispatchUncertain(root, { ...manifest, sourceDigest: "8".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent uncertainty records converge without enabling dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mark-race-"));
  try {
    await createOrInspectRun(root, manifest);
    const observations = await Promise.all(Array.from({ length: 8 }, () => markDispatchUncertain(root, manifest)));
    assert.ok(observations.every(run => run.dispatch === "UNKNOWN_AFTER_DISPATCH" && run.verdict === "BLOCKED"));
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creation binds the input snapshot before asynchronous work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-input-race-"));
  try {
    const supplied = { ...manifest };
    const pending = createOrInspectRun(root, supplied);
    supplied.targetDigest = "8".repeat(64);
    const result = await pending;
    assert.equal(result.run.manifest.targetDigest, manifest.targetDigest);
    assert.equal((await inspectRun(root, manifest.qaRunId)).manifest.targetDigest, manifest.targetDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncertainty recording binds the input snapshot before asynchronous work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-mark-input-"));
  try {
    await createOrInspectRun(root, manifest);
    const supplied = { ...manifest };
    const pending = markDispatchUncertain(root, supplied);
    supplied.authorizationDigest = "9".repeat(64);
    assert.equal((await pending).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("uncertain state survives a separate process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-process-"));
  try {
    const script = `import { createOrInspectRun, markDispatchUncertain } from "./scripts/native-qa/run-store.ts";
      let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
      const manifest = JSON.parse(text); await createOrInspectRun(process.argv[1], manifest); await markDispatchUncertain(process.argv[1], manifest);`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { input: JSON.stringify(manifest), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("dispatch intent binds a publisher job before any receiver call", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-"));
  try {
    await createOrInspectRun(root, manifest);
    const intent = await claimDispatchIntent(root, manifest, "publish-job-123");
    assert.equal(intent.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(intent.publishJobId, "publish-job-123");
    assert.equal((await inspectRun(root, manifest.qaRunId)).publishJobId, "publish-job-123");
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-123"), /QA_DISPATCH_ALREADY_CLAIMED/);
    await assert.rejects(claimDispatchIntent(root, manifest, "different-job"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher stage observations persist in order without claiming native proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publisher-stages-"));
  try {
    await createOrInspectRun(root, manifest);
    const jobId = "publish-job-123";
    const prepared = { jobId, state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/fixture.fcpbundle" };
    const dispatched = { jobId, state: "verification-pending", nextAction: "confirm-verification", delivery: { status: "dispatched" } };
    const verified = { jobId, state: "verified", result: { verified: true, privatePath: "/fixture/fixture.mov" } };
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "dispatched", dispatched), /QA_STAGE_SEQUENCE_INVALID/);
    await recordQaPublisherStage(root, manifest.qaRunId, "prepared", prepared, () => Date.parse("2026-01-02T00:00:00.000Z"));
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "prepared", prepared), /QA_STAGE_SEQUENCE_INVALID/);
    await claimDispatchIntent(root, manifest, jobId);
    await recordQaPublisherStage(root, manifest.qaRunId, "dispatched", dispatched, () => Date.parse("2026-01-01T00:00:00.000Z"));
    await recordQaPublisherStage(root, manifest.qaRunId, "verified", verified, () => Date.parse("2026-01-01T00:00:00.000Z"));
    const observed = await readQaPublisherStages(root, manifest.qaRunId);
    assert.deepEqual(observed.stages.map((entry) => entry.stage), ["prepared", "dispatched", "verified"]);
    assert.ok(observed.stages.every((entry) => entry.recordedAt === "2026-01-02T00:00:00.000Z"));
    assert.equal(observed.stages[0]!.clockAdjusted, false);
    assert.equal(observed.stages[1]!.clockAdjusted, true);
    assert.equal(observed.stages[1]!.observedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED"); assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.dispatchAllowed, false);
    assert.doesNotMatch(JSON.stringify(observed), /\/fixture\//);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "publisher-stages", root, manifest.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), observed);
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "verified", verified), /QA_STAGE_SEQUENCE_INVALID/);
    await writeFile(join(root, manifest.qaRunId, "publisher-stage-2.json"), "{}");
    await assert.rejects(readQaPublisherStages(root, manifest.qaRunId), /QA_STAGE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher stage recorder survives simulated response loss without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-stage-loss-"));
  try {
    await createOrInspectRun(root, manifest);
    let calls = 0;
    const call = async (name: string) => {
      if (name === "artifact.publish.preview") return { jobId: "publish-job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/library" };
      calls++; throw new Error("simulated receiver acknowledgement loss");
    };
    const input = { artifactPath: "/fixture/source", transactionId: "fixture", targetLibraryPath: "/fixture/library", artifactDigest: manifest.artifactDigest };
    const recorder = (stage: string, value: unknown) => recordQaPublisherStage(root, manifest.qaRunId, stage as Parameters<typeof recordQaPublisherStage>[2], value);
    const before = async (jobId: string) => { await claimDispatchIntent(root, manifest, jobId); };
    await assert.rejects(runPublishStages(call, input, recorder, before), /PUBLISH_DISPATCH_UNCERTAIN/);
    const observed = await readQaPublisherStages(root, manifest.qaRunId);
    assert.deepEqual(observed.stages.map((entry) => entry.stage), ["prepared"]);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH"); assert.equal(observed.verdict, "BLOCKED");
    const reopened = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "publisher-stages", root, manifest.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(reopened.status, 0, reopened.stderr); assert.deepEqual(JSON.parse(reopened.stdout), observed);
    await assert.rejects(runPublishStages(call, input, recorder, before), /QA_STAGE_SEQUENCE_INVALID/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent publisher stage claims publish at most one observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-stage-race-"));
  try {
    await createOrInspectRun(root, manifest);
    const prepared = { jobId: "publish-job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest };
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => recordQaPublisherStage(root, manifest.qaRunId, "prepared", prepared)));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.ok(attempts.filter((item) => item.status === "rejected").every((item) => /QA_STAGE_SEQUENCE_INVALID/.test(String(item.reason))));
    assert.equal((await readQaPublisherStages(root, manifest.qaRunId)).stages.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfirmed publisher response cannot be promoted to verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-stage-unconfirmed-"));
  try {
    await createOrInspectRun(root, manifest);
    await recordQaPublisherStage(root, manifest.qaRunId, "prepared", { jobId: "publish-job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest });
    await claimDispatchIntent(root, manifest, "publish-job-123");
    await recordQaPublisherStage(root, manifest.qaRunId, "dispatch-unconfirmed", { jobId: "different-job", privatePath: "/fixture/data" });
    const observed = await readQaPublisherStages(root, manifest.qaRunId);
    assert.deepEqual(observed.stages.map((item) => item.stage), ["prepared", "dispatch-unconfirmed"]);
    assert.doesNotMatch(JSON.stringify(observed), /different-job|\/fixture\//);
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "verified", { jobId: "publish-job-123", state: "verified", result: { verified: true } }), /QA_STAGE_SEQUENCE_INVALID/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher recovery reservation cannot be hidden by a verified stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-stage-recovery-"));
  try {
    await createOrInspectRun(root, manifest);
    const jobId = "publish-job-123";
    await recordQaPublisherStage(root, manifest.qaRunId, "prepared", { jobId, state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest });
    await claimDispatchIntent(root, manifest, jobId);
    await recordQaPublisherStage(root, manifest.qaRunId, "dispatched", { jobId, state: "verification-pending", nextAction: "confirm-verification", delivery: { status: "dispatched" }, recoveryReservation: { retained: true } });
    const response = { jobId, state: "verified", result: { verified: true }, recoveryReservation: { retained: true } };
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "verified", response), /QA_STAGE_OBSERVATION_INVALID/);
    await assert.rejects(recordQaPublisherStage(root, manifest.qaRunId, "verified", { jobId, state: "verified", result: { verified: true } }), /QA_STAGE_OBSERVATION_INVALID/);
    await recordQaPublisherStage(root, manifest.qaRunId, "verification-recovery-required", response);
    const observed = await readQaPublisherStages(root, manifest.qaRunId);
    assert.equal(observed.stages[2]!.stage, "verification-recovery-required");
    assert.equal(observed.verdict, "BLOCKED"); assert.equal(observed.nativeQuiescence, "unproven");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher callbacks persist simulated staged responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-stage-flow-"));
  try {
    await createOrInspectRun(root, manifest);
    const jobId = "publish-job-123";
    let executions = 0;
    const call = async (name: string) => {
      if (name === "artifact.publish.preview") return { jobId, state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/library" };
      executions++;
      return executions === 1
        ? { jobId, state: "verification-pending", nextAction: "confirm-verification", delivery: { status: "dispatched" } }
        : { jobId, state: "verified", result: { verified: true } };
    };
    const recorder = (stage: string, value: unknown) => recordQaPublisherStage(root, manifest.qaRunId, stage as Parameters<typeof recordQaPublisherStage>[2], value);
    await runPublishStages(call, { artifactPath: "/fixture/source", transactionId: "fixture", targetLibraryPath: "/fixture/library", artifactDigest: manifest.artifactDigest }, recorder,
      async (id: string) => { await claimDispatchIntent(root, manifest, id); });
    const observed = await readQaPublisherStages(root, manifest.qaRunId);
    assert.deepEqual(observed.stages.map((entry) => entry.stage), ["prepared", "dispatched", "verified"]);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH"); assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.verdict, "BLOCKED"); assert.equal(executions, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("competing dispatch intent claims have at most one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-race-"));
  try {
    await createOrInspectRun(root, manifest);
    const claims = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => claimDispatchIntent(root, manifest, `job-${i}`)));
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(claims.filter(result => result.status === "rejected").every(result => /QA_DISPATCH_ALREADY_CLAIMED/.test(String(result.reason))));
    assert.match((await inspectRun(root, manifest.qaRunId)).publishJobId ?? "", /^job-[0-7]$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid job identity and stale authorization cannot claim dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-invalid-"));
  try {
    await createOrInspectRun(root, manifest);
    await assert.rejects(claimDispatchIntent(root, manifest, "../secret"), /QA_PUBLISH_JOB_ID_INVALID/);
    await assert.rejects(claimDispatchIntent(root, { ...manifest, authorizationDigest: "9".repeat(64) }, "job-1"), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("simulated lost acknowledgement retains the publisher job and prevents redispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publisher-"));
  try {
    await createOrInspectRun(root, manifest);
    let deliveries = 0;
    const call = async (name: string) => {
      if (name === "artifact.publish.preview") return { jobId: "publish-job-123", state: "awaiting-confirmation", artifactDigest: manifest.artifactDigest, targetLibraryPath: "/fixture/new.fcpbundle" };
      deliveries++;
      const observed = await inspectRun(root, manifest.qaRunId);
      assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
      assert.equal(observed.publishJobId, "publish-job-123");
      throw new Error("simulated acknowledgement loss");
    };
    const input = { artifactPath: "/fixture/source.fcpxml", transactionId: "fixture-1", targetLibraryPath: "/fixture/new.fcpbundle", artifactDigest: manifest.artifactDigest };
    const beforeDispatch = async (jobId: string) => { await claimDispatchIntent(root, manifest, jobId); };
    await assert.rejects(runPublishStages(call, input, () => {}, beforeDispatch), /PUBLISH_DISPATCH_UNCERTAIN/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).publishJobId, "publish-job-123");
    await assert.rejects(runPublishStages(call, input, () => {}, beforeDispatch), /QA_DISPATCH_ALREADY_CLAIMED/);
    assert.equal(deliveries, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher job identity survives a separate process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-job-process-"));
  try {
    const script = `import { createOrInspectRun, claimDispatchIntent } from "./scripts/native-qa/run-store.ts";
      let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
      const manifest = JSON.parse(text); await createOrInspectRun(process.argv[1], manifest); await claimDispatchIntent(process.argv[1], manifest, "publish-job-fixture");`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { input: JSON.stringify(manifest), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.publishJobId, "publish-job-fixture");
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-fixture"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a separate run cannot reuse an operation authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-"));
  try {
    await createOrInspectRun(root, manifest);
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "another-run" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, manifest.qaRunId);
    assert.equal((await createOrInspectRun(root, { ...manifest, qaRunId: "another-run" })).run.manifest.qaRunId, manifest.qaRunId);
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "changed-run", targetDigest: "9".repeat(64) }), /QA_RUN_IDENTITY_MISMATCH/);
    const separate = await createOrInspectRun(root, { ...manifest, qaRunId: "separate-run", targetDigest: "b".repeat(64), authorizationDigest: "a".repeat(64) });
    assert.equal(separate.created, true);
    assert.equal(separate.run.verdict, "BLOCKED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent different run IDs cannot consume the same authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-race-"));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createOrInspectRun(root, { ...manifest, qaRunId: `run-${i}` })));
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.created).length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => /QA_RUN_NOT_FOUND_OR_INCOMPLETE/.test(String(result.reason))));
    const owner = results.find(result => result.status === "fulfilled" && result.value.created);
    assert.ok(owner && owner.status === "fulfilled");
    for (let i = 0; i < 8; i++) {
      const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: `run-${i}` });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.run.manifest.qaRunId, owner.value.run.manifest.qaRunId);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing authorization binding cannot claim a dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-missing-"));
  try {
    await createOrInspectRun(root, manifest);
    await rm(join(root, `.authorization-${manifest.authorizationDigest}`), { recursive: true });
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-1"), /QA_AUTHORIZATION_BINDING_INVALID/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("QA records require a private, owned root and private directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-private-"));
  try {
    await chmod(root, 0o777);
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_ROOT_UNSAFE/);
    await chmod(root, 0o700);
    await createOrInspectRun(root, manifest);
    assert.equal((await lstat(join(root, manifest.qaRunId))).mode & 0o077, 0);
    assert.equal((await lstat(join(root, `.authorization-${manifest.authorizationDigest}`))).mode & 0o077, 0);
    await chmod(root, 0o755);
    await assert.rejects(inspectRun(root, manifest.qaRunId), /QA_RUN_ROOT_UNSAFE/);
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-1"), /QA_RUN_ROOT_UNSAFE/);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});

test("a symbolic link cannot be used as the QA root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "framekit-qa-root-link-"));
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-real-root-"));
  try {
    const link = join(parent, "link");
    await symlink(root, link, "dir");
    await assert.rejects(createOrInspectRun(link, manifest), /QA_RUN_ROOT_UNSAFE/);
  } finally { await rm(parent, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test("duplicate authorization returns the original uncertain job for inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-duplicate-unknown-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "replacement-run" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, manifest.qaRunId);
    assert.equal(duplicate.run.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(duplicate.run.publishJobId, "publish-job-1");
    assert.equal(duplicate.run.verdict, "BLOCKED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an incomplete authorization binding never creates another run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-auth-incomplete-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, `.authorization-${manifest.authorizationDigest}`));
    await assert.rejects(createOrInspectRun(root, manifest), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
    await assert.rejects(createOrInspectRun(root, { ...manifest, qaRunId: "other-run" }), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("detached headless preflight persists evidence after the client exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-supervisor-"));
  const manifestPath = join(root, "manifest.json");
  const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
  try {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, authorizationDigest: null }));
    const start = spawnSync(process.execPath, [...cli, "start", root, manifestPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(start.status, 0, start.stderr);
    const created = JSON.parse(start.stdout);
    assert.equal(created.created, true);
    assert.equal(created.run.dispatch, "NOT_DISPATCHED");
    let content = "";
    for (let i = 0; i < 100; i++) {
      try { content = await readFile(join(root, manifest.qaRunId, "headless-result.json"), "utf8"); if (content.endsWith("\n")) break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(content, "detached worker did not write headless evidence");
    const evidence = spawnSync(process.execPath, [...cli, "evidence", root, manifest.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(evidence.status, 0, evidence.stderr);
    const result = JSON.parse(evidence.stdout);
    assert.equal(result.tier, "headless");
    assert.equal(result.result, "candidate-mismatch");
    assert.equal(result.verdict, "BLOCKED");
    assert.equal(result.dispatch, "NOT_DISPATCHED");
    assert.match(result.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, qaRunId: "different-client-run", authorizationDigest: null }));
    const duplicate = spawnSync(process.execPath, [...cli, "start", root, manifestPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, false);
    assert.equal(JSON.parse(duplicate.stdout).run.manifest.qaRunId, manifest.qaRunId);
    await assert.rejects(lstat(join(root, "different-client-run")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("missing or corrupt headless evidence never enables native work", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-evidence-"));
  try {
    await createOrInspectRun(root, manifest);
    assert.deepEqual(await readQaEvidence(root, manifest.qaRunId), { tier: "headless", result: "pending-or-interrupted", verdict: "BLOCKED", dispatch: "NOT_DISPATCHED" });
    await writeFile(join(root, manifest.qaRunId, "headless-result.json"), "{");
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless evidence rejects unsanitized fields and reversed timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-evidence-invalid-"));
  try {
    await createOrInspectRun(root, manifest);
    const path = join(root, manifest.qaRunId, "headless-result.json");
    const data = { schemaVersion: 1, tier: "headless", result: "render-contract-passed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" };
    await writeFile(join(root, manifest.qaRunId, "headless-started"), JSON.stringify({ schemaVersion: 1, startedAt: data.startedAt }));
    await writeFile(path, JSON.stringify({ ...data, privatePath: "sensitive-value" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
    await writeFile(path, JSON.stringify({ ...data, finishedAt: "2025-01-01T00:00:00.000Z" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("interrupted headless work retains its original start timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-start-evidence-"));
  try {
    await createOrInspectRun(root, manifest);
    const startedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(join(root, manifest.qaRunId, "headless-started"), JSON.stringify({ schemaVersion: 1, startedAt }) + "\n");
    const pending = await readQaEvidence(root, manifest.qaRunId);
    assert.equal(pending.result, "pending-or-interrupted");
    assert.equal(pending.startedAt, startedAt);
    assert.equal(pending.verdict, "BLOCKED");
    await writeFile(join(root, manifest.qaRunId, "headless-result.json"), JSON.stringify({ schemaVersion: 1, tier: "headless", result: "render-contract-passed", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:01.000Z" }));
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt headless start evidence stays blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-start-corrupt-"));
  try {
    await createOrInspectRun(root, manifest);
    await writeFile(join(root, manifest.qaRunId, "headless-started"), "{");
    await assert.rejects(readQaEvidence(root, manifest.qaRunId), /QA_EVIDENCE_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("evidence publication is complete and exclusive for concurrent readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-atomic-"));
  try {
    const path = join(root, "record.json");
    const content = JSON.stringify({ value: "a".repeat(2 * 1024 * 1024) }) + "\n";
    let finished = false;
    let writingError: unknown;
    const writing = publishQaRecord(path, content).then(() => { finished = true; }, error => { writingError = error; finished = true; });
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      try { assert.equal(await readFile(path, "utf8"), content); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(finished, true, "evidence publication did not finish within five seconds");
    await writing;
    if (writingError) throw writingError;
    assert.equal(await readFile(path, "utf8"), content);
    await assert.rejects(publishQaRecord(path, "replacement"), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    assert.equal(await readFile(path, "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless preflight can start without native authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-no-approval-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    const first = await createOrInspectRun(root, unapproved);
    assert.equal(first.created, true);
    assert.equal(first.run.manifest.authorizationDigest, null);
    assert.equal((await createOrInspectRun(root, unapproved)).created, false);
    await assert.rejects(claimDispatchIntent(root, unapproved, "publish-job-1"), /QA_AUTHORIZATION_REQUIRED/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a separate authorization digest can be bound after headless preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-approval-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const digest = "9".repeat(64);
    const bound = await bindQaAuthorization(root, unapproved, digest);
    assert.equal(bound.bound, true);
    assert.equal(bound.run.manifest.authorizationDigest, null);
    assert.equal(bound.run.authorizationBinding, digest);
    assert.equal((await inspectRun(root, unapproved.qaRunId)).authorizationBinding, digest);
    assert.equal((await bindQaAuthorization(root, unapproved, digest)).bound, false);
    await assert.rejects(bindQaAuthorization(root, unapproved, "a".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    assert.equal((await claimDispatchIntent(root, unapproved, "publish-job-1")).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authorization binding rejects changed identity and uncertain runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-identity-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await assert.rejects(bindQaAuthorization(root, { ...unapproved, targetDigest: "a".repeat(64) }, "9".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    await markDispatchUncertain(root, unapproved);
    await assert.rejects(bindQaAuthorization(root, unapproved, "9".repeat(64)), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one authorization cannot bind different target identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-target-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const other = { ...first, qaRunId: "other-run", targetDigest: "a".repeat(64) };
    await createOrInspectRun(root, first);
    await createOrInspectRun(root, other);
    await bindQaAuthorization(root, first, "9".repeat(64));
    await assert.rejects(bindQaAuthorization(root, other, "9".repeat(64)), /QA_RUN_IDENTITY_MISMATCH/);
    await assert.rejects(claimDispatchIntent(root, other, "publish-job-2"), /QA_AUTHORIZATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate later authorization returns the original run without a new claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-duplicate-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const second = { ...first, qaRunId: "second-run" };
    await createOrInspectRun(root, first);
    const preflight = await createOrInspectRun(root, second);
    assert.equal(preflight.created, false);
    await bindQaAuthorization(root, first, "9".repeat(64));
    const duplicate = await bindQaAuthorization(root, preflight.run.manifest, "9".repeat(64));
    assert.equal(duplicate.bound, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
    await assert.rejects(claimDispatchIntent(root, second, "publish-job-2"), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent authorization bindings have at most one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-race-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => bindQaAuthorization(root, unapproved, "9".repeat(64))));
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.bound).length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => /QA_AUTHORIZATION_BINDING_INCOMPLETE/.test(String(result.reason))));
    assert.equal((await inspectRun(root, unapproved.qaRunId)).authorizationBinding, "9".repeat(64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing bound authorization index blocks inspection and claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-bind-missing-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await bindQaAuthorization(root, unapproved, "9".repeat(64));
    await rm(join(root, `.authorization-${"9".repeat(64)}`), { recursive: true });
    await assert.rejects(inspectRun(root, unapproved.qaRunId), /QA_RUN_CORRUPT/);
    await assert.rejects(claimDispatchIntent(root, unapproved, "publish-job-1"), /QA_RUN_CORRUPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a later authorized duplicate inspects the existing preflight run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-later-duplicate-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await bindQaAuthorization(root, unapproved, "9".repeat(64));
    const duplicate = await createOrInspectRun(root, { ...manifest, qaRunId: "later-run", authorizationDigest: "9".repeat(64) });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, unapproved.qaRunId);
    assert.equal(duplicate.run.authorizationBinding, "9".repeat(64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI records a separate digest without claiming consent or dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cli-binding-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "record-authorization", root, unapproved.qaRunId, "9".repeat(64)], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.bound, true);
    assert.equal(value.run.authorizationBinding, "9".repeat(64));
    assert.equal(value.authorizationVerified, false);
    assert.equal(value.dispatchAllowed, false);
    assert.equal(value.run.dispatch, "NOT_DISPATCHED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unapproved duplicate starts inspect the original job across run IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-preflight-duplicate-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const second = { ...first, qaRunId: "second-preflight" };
    assert.equal((await createOrInspectRun(root, first)).created, true);
    const duplicate = await createOrInspectRun(root, second);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
    const changed = { ...second, targetDigest: "a".repeat(64) };
    assert.equal((await createOrInspectRun(root, changed)).created, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("competing unapproved starts create at most one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-preflight-race-"));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createOrInspectRun(root, { ...manifest, qaRunId: `preflight-${i}`, authorizationDigest: null })));
    const created = results.filter(result => result.status === "fulfilled" && result.value.created);
    assert.equal(created.length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("an authorized start cannot bypass the existing unapproved job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cross-form-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    const authorized = { ...manifest, qaRunId: "other-start", authorizationDigest: "9".repeat(64) };
    await createOrInspectRun(root, first);
    await assert.rejects(createOrInspectRun(root, authorized), /QA_RUN_IDENTITY_MISMATCH/);
    await bindQaAuthorization(root, first, "9".repeat(64));
    const duplicate = await createOrInspectRun(root, authorized);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.manifest.qaRunId, first.qaRunId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("racing authorized and unapproved starts create at most one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-cross-form-race-"));
  try {
    const unapproved = { ...manifest, qaRunId: "without-approval", authorizationDigest: null };
    const authorized = { ...manifest, qaRunId: "with-approval" };
    const results = await Promise.allSettled([createOrInspectRun(root, unapproved), createOrInspectRun(root, authorized)]);
    assert.equal(results.filter(result => result.status === "fulfilled" && result.value.created).length, 1);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /QA_RUN_NOT_FOUND_OR_INCOMPLETE|QA_RUN_IDENTITY_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a missing job index cannot turn an uncertain run into a new job", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-lost-index-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    await markDispatchUncertain(root, first);
    const indices = (await readdir(root)).filter(name => name.startsWith(".job-"));
    assert.equal(indices.length, 1);
    await rm(join(root, indices[0]!), { recursive: true });
    await assert.rejects(createOrInspectRun(root, { ...first, qaRunId: "replacement-run" }), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(root, first.qaRunId)).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown or corrupt existing runs block new job registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-corrupt-index-scan-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    await writeFile(join(root, first.qaRunId, "run.json"), "{");
    const different = { ...first, qaRunId: "another-job", targetDigest: "a".repeat(64) };
    await assert.rejects(createOrInspectRun(root, different), /QA_INDEX_RECONCILIATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing job index blocks authorization binding and dispatch claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-index-mutation-"));
  try {
    const first = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, first);
    const index = (await readdir(root)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(root, index), { recursive: true });
    await assert.rejects(bindQaAuthorization(root, first, "9".repeat(64)), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(root, first.qaRunId)).authorizationBinding, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }

  const otherRoot = await mkdtemp(join(tmpdir(), "framekit-qa-index-claim-"));
  try {
    await createOrInspectRun(otherRoot, manifest);
    const index = (await readdir(otherRoot)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(otherRoot, index), { recursive: true });
    await assert.rejects(claimDispatchIntent(otherRoot, manifest, "publish-job-1"), /QA_INDEX_RECONCILIATION_REQUIRED/);
    assert.equal((await inspectRun(otherRoot, manifest.qaRunId)).dispatch, "NOT_DISPATCHED");
  } finally { await rm(otherRoot, { recursive: true, force: true }); }
});

test("an interrupted pre-spawn run can explicitly resume headless work only", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-headless-"));
  const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const resumed = spawnSync(process.execPath, [...cli, "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).scheduled, true);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, unapproved.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(evidence?.dispatch, "NOT_DISPATCHED");
    const repeated = spawnSync(process.execPath, [...cli, "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).scheduled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless resume refuses a dispatch-uncertain run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-uncertain-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await markDispatchUncertain(root, unapproved);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "resume-headless", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("headless resume requires an intact job index", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-resume-index-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const index = (await readdir(root)).find(name => name.startsWith(".job-"));
    assert.ok(index);
    await rm(join(root, index), { recursive: true });
    await assert.rejects(resumeHeadlessQaRun(root, unapproved.qaRunId), /QA_INDEX_RECONCILIATION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("simultaneous worker-start records have one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-worker-claim-"));
  try {
    const path = join(root, "started");
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => publishQaRecord(path, `worker-${i}\n`)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => (result.reason as NodeJS.ErrnoException).code === "EEXIST"));
    assert.match(await readFile(path, "utf8"), /^worker-[0-7]\n$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a crash while writing dispatch intent cannot expose a partial marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-intent-crash-"));
  const script = `import { createOrInspectRun, claimDispatchIntent } from "./scripts/native-qa/run-store.ts";
    import { open, readdir, stat } from "node:fs/promises"; import { join } from "node:path";
    let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
    const manifest = JSON.parse(text); const root = process.argv[1]; await createOrInspectRun(root, manifest);
    const directory = join(root, manifest.qaRunId); const probe = await open(join(directory, "test-probe"), "wx");
    const proto = Object.getPrototypeOf(probe); const original = proto.writeFile; await probe.close();
    proto.writeFile = async function(...args) {
      const current = await this.stat();
      for (const name of await readdir(directory)) {
        if (!name.startsWith("dispatch-uncertain")) continue;
        const candidate = await stat(join(directory, name)).catch(() => undefined);
        if (candidate && candidate.ino === current.ino && candidate.dev === current.dev) {
          process.send({ writing: true }); await new Promise(() => {});
        }
      }
      return original.apply(this, args);
    };
    await claimDispatchIntent(root, manifest, "publish-job-fixture");`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  try {
    child.stdin!.end(JSON.stringify(manifest));
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => { throw new Error("intent process exited before write"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("intent write timed out")), 10000); timer.unref(); }),
    ]);
    assert.deepEqual(message, { writing: true });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const run = await inspectRun(root, manifest.qaRunId);
    assert.equal(run.dispatch, "NOT_DISPATCHED");
    assert.equal(run.publishJobId, undefined);
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("simulated receiver acceptance survives a publisher process crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-acceptance-crash-"));
  const script = `import { createOrInspectRun, claimDispatchIntent } from "./scripts/native-qa/run-store.ts";
    import { runPublishStages } from "./scripts/final-cut-publisher-verification.mjs";
    import { recordQaPublisherStage } from "./scripts/native-qa/publisher-stages.ts";
    let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
    const manifest = JSON.parse(text); const root = process.argv[1]; await createOrInspectRun(root, manifest);
    const call = async name => {
      if (name === "artifact.publish.preview") return {jobId:"publish-job-fixture", state:"awaiting-confirmation", artifactDigest:manifest.artifactDigest, targetLibraryPath:"fixture-target"};
      process.send({accepted:true}); await new Promise(() => {});
    };
    await runPublishStages(call, {artifactPath:"fixture-artifact", transactionId:"fixture", targetLibraryPath:"fixture-target", artifactDigest:manifest.artifactDigest}, (stage, value) => recordQaPublisherStage(root, manifest.qaRunId, stage, value), async jobId => { await claimDispatchIntent(root, manifest, jobId); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  try {
    assert.ok(child.stdin);
    child.stdin.end(JSON.stringify(manifest));
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => { throw new Error("simulated receiver process exited before acceptance"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("simulated receiver acceptance timed out")), 10000); timer.unref(); }),
    ]);
    assert.deepEqual(message, { accepted: true });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const observed = await inspectRun(root, manifest.qaRunId);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.publishJobId, "publish-job-fixture");
    assert.equal(observed.verdict, "BLOCKED");
    const stagesAfterCrash = await readQaPublisherStages(root, manifest.qaRunId);
    assert.deepEqual(stagesAfterCrash.stages.map((item) => item.stage), ["prepared"]);
    assert.equal(stagesAfterCrash.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal((await createOrInspectRun(root, manifest)).created, false);
    await assert.rejects(claimDispatchIntent(root, manifest, "publish-job-fixture"), /QA_DISPATCH_ALREADY_CLAIMED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("client loss before dispatch preserves a resumable headless run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-before-dispatch-"));
  const unapproved = { ...manifest, authorizationDigest: null };
  const script = `import { createOrInspectRun } from "./scripts/native-qa/run-store.ts";
    let text = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) text += chunk;
    await createOrInspectRun(process.argv[1], JSON.parse(text)); process.send({recorded:true}); await new Promise(() => {});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  try {
    assert.ok(child.stdin);
    child.stdin.end(JSON.stringify(unapproved));
    const message = await Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => { throw new Error("client exited before recording the run"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("client recording timed out")), 10000); timer.unref(); }),
    ]);
    assert.deepEqual(message, { recorded: true });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal((await inspectRun(root, unapproved.qaRunId)).dispatch, "NOT_DISPATCHED");
    assert.equal((await createOrInspectRun(root, unapproved)).created, false);
    assert.equal((await resumeHeadlessQaRun(root, unapproved.qaRunId)).scheduled, true);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, unapproved.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(evidence?.dispatch, "NOT_DISPATCHED");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});


test("artifact verification records a sanitized digest snapshot without authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const contents = "<fcpxml>fixture</fcpxml>\n";
    await writeFile(path, contents);
    const unapproved = { ...manifest, authorizationDigest: null, artifactDigest: createHash("sha256").update(contents).digest("hex") };
    await createOrInspectRun(root, unapproved);
    const evidence = await verifyQaArtifact(root, unapproved.qaRunId, path);
    assert.equal(evidence.result, "digest-matched");
    assert.equal(evidence.tier, "artifact");
    assert.equal(evidence.scope, "snapshot-only");
    assert.equal(evidence.artifactDigest, unapproved.artifactDigest);
    assert.equal(evidence.dispatchAllowed, false);
    assert.equal(JSON.stringify(evidence).includes(path), false);
    assert.deepEqual(await readQaArtifactEvidence(root, unapproved.qaRunId), evidence);
    assert.deepEqual(await verifyQaArtifact(root, unapproved.qaRunId, path), evidence);
    await writeFile(path, "changed artifact");
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, path), /QA_ARTIFACT_DIGEST_MISMATCH/);
    assert.deepEqual(await readQaArtifactEvidence(root, unapproved.qaRunId), evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact mismatch and symlinks never create matching evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-invalid-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const link = join(root, "fixture-link.fcpxml");
    await writeFile(path, "unapproved");
    await symlink(path, link);
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, path), /QA_ARTIFACT_DIGEST_MISMATCH/);
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, link), /QA_ARTIFACT_UNSAFE/);
    assert.equal(await readQaArtifactEvidence(root, unapproved.qaRunId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI verifies and retrieves artifact evidence without exposing its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-cli-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const contents = "<fcpxml/>\n";
    await writeFile(path, contents);
    const unapproved = { ...manifest, authorizationDigest: null, artifactDigest: createHash("sha256").update(contents).digest("hex") };
    await createOrInspectRun(root, unapproved);
    const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
    const verified = spawnSync(process.execPath, [...cli, "verify-artifact", root, unapproved.qaRunId, path], { encoding: "utf8", timeout: 10000 });
    assert.equal(verified.status, 0, verified.stderr);
    const record = JSON.parse(verified.stdout);
    assert.equal(record.result, "digest-matched");
    assert.equal(record.scope, "snapshot-only");
    assert.equal(record.dispatchAllowed, false);
    assert.equal(verified.stdout.includes(path), false);
    const read = spawnSync(process.execPath, [...cli, "artifact-evidence", root, unapproved.qaRunId], { encoding: "utf8", timeout: 10000 });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), record);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt artifact evidence cannot be reused or silently overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-corrupt-"));
  try {
    const path = join(root, "fixture.fcpxml");
    const contents = "<fcpxml/>\n";
    await writeFile(path, contents);
    const unapproved = { ...manifest, authorizationDigest: null, artifactDigest: createHash("sha256").update(contents).digest("hex") };
    await createOrInspectRun(root, unapproved);
    await verifyQaArtifact(root, unapproved.qaRunId, path);
    const evidencePath = join(root, unapproved.qaRunId, "artifact-evidence.json");
    await writeFile(evidencePath, "{");
    await assert.rejects(readQaArtifactEvidence(root, unapproved.qaRunId), /QA_EVIDENCE_CORRUPT/);
    await assert.rejects(verifyQaArtifact(root, unapproved.qaRunId, path), /QA_EVIDENCE_CORRUPT/);
    assert.equal(await readFile(evidencePath, "utf8"), "{");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("artifact verification rejects a named pipe without waiting for a writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-artifact-fifo-"));
  try {
    const path = join(root, "artifact-pipe");
    execFileSync("mkfifo", [path]);
    const unapproved = { ...manifest, authorizationDigest: null };
    await createOrInspectRun(root, unapproved);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "verify-artifact", root, unapproved.qaRunId, path], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined, "verification timed out opening a named pipe");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /QA_ARTIFACT_UNSAFE/);
    assert.equal(await readQaArtifactEvidence(root, unapproved.qaRunId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detached headless input keeps artifact paths out of output and records", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-worker-artifact-"));
  const manifestPath = join(root, "manifest.json");
  const artifactPath = join(root, "fixture.fcpxml");
  const cli = ["--import", "tsx", "scripts/native-qa/cli.ts"];
  try {
    await writeFile(artifactPath, "<fcpxml/>\n");
    await writeFile(manifestPath, JSON.stringify({ ...manifest, authorizationDigest: null }));
    const started = spawnSync(process.execPath, [...cli, "start", root, manifestPath, artifactPath], { encoding: "utf8", timeout: 10000 });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout.includes(artifactPath), false);
    let evidence;
    for (let i = 0; i < 100; i++) {
      evidence = await readQaEvidence(root, manifest.qaRunId);
      if (evidence.result !== "pending-or-interrupted") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(evidence?.result, "candidate-mismatch");
    assert.equal(await readQaArtifactEvidence(root, manifest.qaRunId), null);
    const files = await readdir(join(root, manifest.qaRunId));
    for (const name of files) assert.equal((await readFile(join(root, manifest.qaRunId, name), "utf8")).includes(artifactPath), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("invalid worker artifact input is rejected before creating a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-invalid-worker-input-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    await assert.rejects(startQaRun(root, unapproved, "relative.fcpxml"), /QA_ARTIFACT_UNSAFE/);
    await assert.rejects(lstat(join(root, unapproved.qaRunId)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized encoded worker input is rejected before recording a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-worker-input-limit-"));
  try {
    const unapproved = { ...manifest, authorizationDigest: null };
    const path = "/" + "\u0001".repeat(3000);
    await assert.rejects(startQaRun(root, unapproved, path), /QA_ARTIFACT_UNSAFE/);
    await assert.rejects(lstat(join(root, unapproved.qaRunId)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("publisher inspection reads only status and sanitizes private fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publish-inspect-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    const calls: Array<{ name: string; args: unknown }> = [];
    const observed = await inspectQaPublisher(root, manifest.qaRunId, async (name, args) => {
      calls.push({ name, args });
      return { jobId: "publish-job-1", state: "verification-pending", artifactDigest: manifest.artifactDigest, nextAction: "confirm-verification", sourcePath: "sensitive-value", result: { verified: true } };
    });
    assert.deepEqual(calls, [{ name: "artifact.publish.status", args: { jobId: "publish-job-1" } }]);
    assert.equal(observed.dispatch, "UNKNOWN_AFTER_DISPATCH");
    assert.equal(observed.verdict, "BLOCKED");
    assert.ok("observedState" in observed);
    assert.equal(observed.observedState, "verification-pending");
    assert.equal(observed.nextAction, "inspect-recovery");
    assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.dispatchAllowed, false);
    assert.equal(JSON.stringify(observed).includes("sensitive-value"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher status never makes verified or failed observations replayable", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publish-status-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    for (const state of ["awaiting-confirmation", "awaiting-final-cut", "verified", "failed"]) {
      const result = await inspectQaPublisher(root, manifest.qaRunId, async () => ({ jobId: "publish-job-1", state, artifactDigest: manifest.artifactDigest }));
      assert.equal(result.dispatch, "UNKNOWN_AFTER_DISPATCH");
      assert.equal(result.verdict, "BLOCKED");
      assert.equal(result.nextAction, "inspect-recovery");
      assert.equal(result.nativeQuiescence, "unproven");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher inspection rejects mismatched identity and handles unavailable status", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publish-unavailable-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    await assert.rejects(inspectQaPublisher(root, manifest.qaRunId, async () => ({ jobId: "other-job", state: "verified", artifactDigest: manifest.artifactDigest })), /QA_PUBLISH_STATUS_IDENTITY_MISMATCH/);
    const unavailable = await inspectQaPublisher(root, manifest.qaRunId, async () => { throw new Error("sensitive-value"); });
    assert.equal(unavailable.nextAction, "status-unavailable");
    assert.equal(unavailable.verdict, "BLOCKED");
    assert.equal(JSON.stringify(unavailable).includes("sensitive-value"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher inspection never queries without a recorded job ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-publish-no-job-"));
  try {
    await createOrInspectRun(root, manifest);
    let calls = 0;
    const call = async () => { calls++; return {}; };
    assert.equal((await inspectQaPublisher(root, manifest.qaRunId, call)).nextAction, "inspect-run");
    await markDispatchUncertain(root, manifest);
    assert.equal((await inspectQaPublisher(root, manifest.qaRunId, call)).nextAction, "job-id-unavailable");
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher status inspection rejects run identity changes during the call", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-status-race-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = inspectQaPublisher(root, manifest.qaRunId, async () => {
      entered();
      return await new Promise(resolve => { release = resolve; });
    });
    await started;
    await writeFile(join(root, manifest.qaRunId, "run.json"), JSON.stringify({ schemaVersion: 1, manifest: { ...manifest, sourceDigest: "a".repeat(64) }, dispatch: "NOT_DISPATCHED", verdict: "BLOCKED" }));
    release({ jobId: "publish-job-1", state: "verified", artifactDigest: manifest.artifactDigest });
    await assert.rejects(pending, /QA_PUBLISH_STATUS_IDENTITY_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher status inspection has a bounded wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-status-timeout-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    let signal: AbortSignal | undefined;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      result = await Promise.race([
        inspectQaPublisher(root, manifest.qaRunId, async (_name, _args, options) => { signal = options.signal; return await new Promise(() => {}); }, { timeoutMs: 20 }),
        new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error("status inspection did not time out")), 5000); }),
      ]);
    } finally { if (guard) clearTimeout(guard); }
    assert.equal(signal?.aborted, true);
    assert.equal(result.nextAction, "status-unavailable");
    assert.equal(result.verdict, "BLOCKED");
    assert.equal(result.dispatchAllowed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("publisher inspection uses the production MCP status tool without executing", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-status-mcp-"));
  const calls: string[] = [];
  const publisher = {
    loadPublishJob: async (jobId: string) => { calls.push(`status:${jobId}`); return { jobId, state: "verification-pending", artifactDigest: manifest.artifactDigest, sourcePath: "sensitive-value" }; },
    executePublishJob: async () => { calls.push("execute"); throw new Error("unexpected execution"); },
    isAvailable: () => false,
  };
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "fixture-project", projectName: "Fixture", timelineId: "fixture-sequence", timelineName: "Main", clips: [], media: [] }));
  const server = createMcpServer(runtime, { projectPublisher: publisher as never, sessionDirectory: join(root, "sessions") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "qa-status-fixture", version: "1" });
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const observed = await inspectQaPublisher(root, manifest.qaRunId, async (name, args, options) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { signal: options.signal });
      assert.equal(response.isError ?? false, false);
      assert.ok(Array.isArray(response.content));
      const first = response.content[0] as { type?: string; text?: unknown } | undefined;
      assert.ok(first && first.type === "text" && typeof first.text === "string");
      return JSON.parse(first.text);
    });
    assert.ok("observedState" in observed);
    assert.equal(observed.observedState, "verification-pending");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.dispatchAllowed, false);
    assert.equal(JSON.stringify(observed).includes("sensitive-value"), false);
    assert.deepEqual(calls, ["status:publish-job-1"]);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});


test("publisher inspection reads a persisted fixture without changing its store", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-status-"));
  const store = await mkdtemp(join(tmpdir(), "framekit-qa-publisher-store-"));
  try {
    const sourcePath = join(store, "fixture.fcpxml");
    const source = '<fcpxml version="1.11"><library><event><project uid="fixture-project" name="Fixture"><sequence uid="fixture-sequence" name="Main" /></project></event></library></fcpxml>';
    await writeFile(sourcePath, source);
    const publisher = new FinalCutProjectPublisher({ enabled: false, sourcePath, publishJobsDirectory: store });
    const job = await publisher.preparePublish({ sourceTransactionId: "fixture-transaction", artifactPath: sourcePath, artifactDigest: createHash("sha256").update(source).digest("hex") });
    const bound = { ...manifest, artifactDigest: job.artifactDigest };
    await createOrInspectRun(root, bound);
    await claimDispatchIntent(root, bound, job.jobId);
    const jobPath = join(store, `${job.jobId}.json`);
    const before = await readFile(jobPath, "utf8");
    const beforeMode = (await lstat(store)).mode;
    const observed = await inspectQaPublisherFromStore(root, bound.qaRunId, store);
    assert.ok("observedState" in observed);
    assert.equal(observed.observedState, "awaiting-confirmation");
    assert.equal(observed.verdict, "BLOCKED");
    assert.equal(observed.nativeQuiescence, "unproven");
    assert.equal(observed.dispatchAllowed, false);
    assert.equal(JSON.stringify(observed).includes(sourcePath), false);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-qa/cli.ts", "inspect-publisher-store", root, bound.qaRunId, store], { encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), observed);
    assert.equal(cli.stdout.includes(store), false);
    assert.equal(await readFile(jobPath, "utf8"), before);
    assert.equal((await lstat(store)).mode, beforeMode);
  } finally { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }); }
});

test("publisher inspection never creates a missing store or follows a linked store", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-missing-"));
  const parent = await mkdtemp(join(tmpdir(), "framekit-qa-store-parent-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-00000000-0000-0000-0000-000000000001");
    const missing = join(parent, "missing");
    const observed = await inspectQaPublisherFromStore(root, manifest.qaRunId, missing);
    assert.equal(observed.nextAction, "status-unavailable");
    await assert.rejects(lstat(missing), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const link = join(parent, "linked");
    await symlink(root, link, "dir");
    assert.equal((await inspectQaPublisherFromStore(root, manifest.qaRunId, link)).nextAction, "status-unavailable");
  } finally { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); }
});


test("publisher inspection rejects corrupt or linked persisted job files", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-store-invalid-"));
  const store = await mkdtemp(join(tmpdir(), "framekit-qa-publisher-invalid-"));
  try {
    const jobId = "publish-job-00000000-0000-0000-0000-000000000001";
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, jobId);
    const jobPath = join(store, `${jobId}.json`);
    await writeFile(jobPath, "{");
    assert.equal((await inspectQaPublisherFromStore(root, manifest.qaRunId, store)).nextAction, "status-unavailable");
    await rm(jobPath);
    const target = join(store, "unrelated");
    await writeFile(target, "fixture");
    await symlink(target, jobPath);
    assert.equal((await inspectQaPublisherFromStore(root, manifest.qaRunId, store)).nextAction, "status-unavailable");
    assert.equal(await readFile(target, "utf8"), "fixture");
  } finally { await rm(root, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }); }
});


test("publisher inspection rejects a status for a different artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-qa-status-artifact-"));
  try {
    await createOrInspectRun(root, manifest);
    await claimDispatchIntent(root, manifest, "publish-job-1");
    await assert.rejects(inspectQaPublisher(root, manifest.qaRunId, async () => ({ jobId: "publish-job-1", state: "verified", artifactDigest: "a".repeat(64) })), /QA_PUBLISH_STATUS_IDENTITY_MISMATCH/);
    assert.equal((await inspectRun(root, manifest.qaRunId)).dispatch, "UNKNOWN_AFTER_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});
