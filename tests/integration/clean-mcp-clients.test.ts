import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { sanitizeCleanMcpEvidence } from "../../scripts/clean-mcp-client-evidence.mjs";
import { assertMcpServerVersion } from "../../scripts/mcp-version.mjs";
import { assessReleaseCandidate } from "../../scripts/release-candidate-evidence.mjs";

const repository = resolve(process.cwd());

test("MCP version validation requires exact package provenance", () => {
  assert.doesNotThrow(() => assertMcpServerVersion("0.1.4", "0.1.4", "clean client"));
  assert.throws(
    () => assertMcpServerVersion("0.1.0", "0.1.4", "clean client"),
    /MCP_SERVER_VERSION_MISMATCH/,
  );
  assert.throws(
    () => assertMcpServerVersion(undefined, "0.1.4", "clean client"),
    /MCP_SERVER_VERSION_MISSING/,
  );
});

test("clean MCP client runner covers the required setup and workflow", async () => {
  const runner = await readFile(resolve(repository, "scripts/clean-mcp-client-smoke.mjs"), "utf8");

  for (const expected of [
    '"marketplace", "add", root',
    "codex plugin add framekit@framekit",
    "claude mcp add",
    "connection.status",
    "headless.project.inspect",
    "headless.edit.execute",
    "speech.analyze",
    "@modelcontextprotocol/sdk",
    "initialize",
    "assertMcpServerVersion",
    "gitHead",
    "buildFingerprint",
    "releaseCandidate",
    "nativeFinalCut",
    "FRAMEKIT_CLEAN_MCP_EVIDENCE_OUTPUT",
  ]) {
    assert.match(runner, new RegExp(escapeRegExp(expected), "i"));
  }
});

test("clean MCP evidence preserves both client records and versioned workflow results", () => {
  const evidence = sanitizeCleanMcpEvidence(rawEvidence());

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.evidenceType, "clean-mcp-client-workflow");
  assert.deepEqual(evidence.clients.map((client) => client.name), ["Codex", "Claude Code"]);
  assert.deepEqual(evidence.clients.map((client) => client.clientVersion), ["0.144.1", "2.1.231"]);
  assert.equal(evidence.framekit.version, "0.1.0");
  assert.equal(evidence.runtime.version, "0.1.0");
  assert.deepEqual(evidence.clients[0]?.workflow.tools, [
    { name: "headless.project.create", status: "passed" },
    { name: "headless.project.inspect", status: "passed" },
    { name: "speech.analyze", status: "passed" },
    { name: "headless.edit.preview", status: "passed" },
    { name: "headless.edit.execute", status: "passed" },
    { name: "editing.route", status: "headless-selected" },
  ]);
});

test("clean MCP evidence reports package fingerprints and release artifact GO or NO_GO states", () => {
	const raw = rawEvidence() as ReturnType<typeof rawEvidence> & { releaseCandidate?: unknown };
	const candidateCommit = raw.environment.gitCommit;
	Object.assign(raw.clients[0]!.registration, {
		plugin: { version: "0.1.0", commit: candidateCommit },
		packageSource: "packed-source",
		publicPackage: { status: "mismatched", version: "0.1.0", commit: "f".repeat(40), reason: "published npm commit does not match the release candidate" },
	});
	Object.assign(raw.clients[0]!.server, {
		buildFingerprint: { version: "0.1.0", commit: candidateCommit },
	});
	Object.assign(raw.clients[0]!.workflow, {
		delivery: {
			processMode: "headless",
			headless: { status: "passed", backend: "fixture", requiredCapabilities: ["headless.timeline.edit.add-title"] },
			nativeFinalCut: { status: "blocked", reason: "native import and readback were not tested" },
		},
	});
	raw.releaseCandidate = assessReleaseCandidate({
		target: { version: "0.1.0", commit: candidateCommit },
		artifacts: {
			npmPackage: { available: true, version: "0.1.0", commit: "f".repeat(40) },
			codexPlugin: { installed: true, version: "0.1.0", commit: candidateCommit },
			mcpServer: { connected: true, version: "0.1.0", commit: candidateCommit },
			nativeExtension: { verified: false, reason: "signed native assets are not available" },
		},
	});

	const evidence = sanitizeCleanMcpEvidence(raw);
	assert.equal(evidence.clients[0]?.server.buildFingerprint?.commit, candidateCommit);
	assert.equal(evidence.clients[0]?.registration.plugin?.commit, candidateCommit);
	assert.equal(evidence.clients[0]?.registration.publicPackage?.status, "mismatched");
	assert.equal(evidence.clients[0]?.registration.packageSource, "packed-source");
	assert.equal(evidence.clients[0]?.workflow.delivery?.processMode, "headless");
	assert.equal(evidence.clients[0]?.workflow.delivery?.nativeFinalCut.status, "blocked");
	assert.equal(evidence.releaseCandidate?.status, "NO_GO");
	assert.equal(evidence.releaseCandidate?.artifacts.nativeExtension.status, "NO_GO");
});

test("clean MCP evidence omits private paths, transaction IDs, and raw diagnostics", () => {
  const evidence = sanitizeCleanMcpEvidence(rawEvidence());
  const serialized = JSON.stringify(evidence);

  assert.doesNotMatch(serialized, /Users\/private|secret-footage|transaction-secret|raw crash dump|api-key/i);
  assert.match(serialized, /allowlisted-summary/);
  assert.match(serialized, /CAPABILITY_UNAVAILABLE/);
});

test("clean MCP evidence rejects prohibited free-text fields", () => {
  const unsafe = rawEvidence();
  unsafe.clients[0]!.registration.command =
    "claude mcp add --env API_KEY=top-secret -- /Users/private/secret-footage.mov";

  assert.throws(
    () => sanitizeCleanMcpEvidence(unsafe),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Codex registration command contains prohibited content/,
  );

  unsafe.clients[0]!.registration.command = "claude mcp add --env API_KEY top-secret";
  assert.throws(
    () => sanitizeCleanMcpEvidence(unsafe),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Codex registration command contains prohibited content/,
  );

  unsafe.clients[0]!.registration.command = "claude mcp add framekit";
  unsafe.clients[0]!.workflow.limitations[0] = "raw crash dump: transaction id: tx-secret";
  assert.throws(
    () => sanitizeCleanMcpEvidence(unsafe),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Codex limitation contains prohibited content/,
  );
});

test("clean MCP evidence permits ordinary prose mentioning 'key' without actual credentials", () => {
  const safe = rawEvidence();
  safe.clients[0]!.workflow.limitations[0] = "No API key is required for this operation";
  safe.clients[0]!.workflow.limitations[1] = "The secret to success is practice";

  const evidence = sanitizeCleanMcpEvidence(safe);

  assert.equal(evidence.clients[0]?.workflow.limitations[0], "No API key is required for this operation");
  assert.equal(evidence.clients[0]?.workflow.limitations[1], "The secret to success is practice");
});

test("clean MCP evidence still rejects actual whitespace-delimited credentials", () => {
  const unsafe = rawEvidence();
  unsafe.clients[0]!.registration.command = "start --env API_KEY top-secret";

  assert.throws(
    () => sanitizeCleanMcpEvidence(unsafe),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Codex registration command contains prohibited content/,
  );

  unsafe.clients[0]!.registration.command = "export PASSWORD hunter2 && run";
  assert.throws(
    () => sanitizeCleanMcpEvidence(unsafe),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Codex registration command contains prohibited content/,
  );
});

test("clean MCP evidence rejects incomplete client workflows", () => {
  const incomplete = rawEvidence();
  incomplete.clients[1]!.workflow.tools = incomplete.clients[1]!.workflow.tools.slice(0, 5);

  assert.throws(
    () => sanitizeCleanMcpEvidence(incomplete),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Claude Code workflow is incomplete/,
  );
});

test("clean MCP evidence permits a selected single-client diagnostic", () => {
  const partial = rawEvidence();
  partial.clients = [partial.clients[0]!];

  const evidence = sanitizeCleanMcpEvidence(partial, { expectedClientNames: ["Codex"] });

  assert.deepEqual(evidence.clients.map((client) => client.name), ["Codex"]);
});

test("dirty clean-client evidence cannot report a GO release candidate", () => {
	const raw = rawEvidence() as ReturnType<typeof rawEvidence> & { releaseCandidate?: unknown };
	raw.environment.sourceClean = false;
	raw.releaseCandidate = assessReleaseCandidate({
		target: {
			version: "0.1.0",
			commit: raw.environment.gitCommit,
			sourceClean: false,
		},
		artifacts: {
			npmPackage: { available: true, version: "0.1.0", commit: raw.environment.gitCommit },
			codexPlugin: { installed: true, version: "0.1.0", commit: raw.environment.gitCommit },
			mcpServer: { connected: true, version: "0.1.0", commit: raw.environment.gitCommit },
			nativeExtension: {
				verified: true,
				version: "0.1.0",
				commit: raw.environment.gitCommit,
				signed: true,
				checksumVerified: true,
			},
		},
	});

	const evidence = sanitizeCleanMcpEvidence(raw, { expectedClientNames: ["Codex", "Claude Code"] });

	assert.equal(evidence.environment.sourceClean, false);
	assert.equal(evidence.releaseCandidate?.status, "NO_GO");
	assert.ok(Object.values(evidence.releaseCandidate?.artifacts ?? {}).every((artifact) => artifact.status === "NO_GO"));
	raw.environment.sourceClean = true;
	assert.throws(
		() => sanitizeCleanMcpEvidence(raw),
		/release candidate and workflow source cleanliness do not match/i,
	);
});

test("checked-in clean MCP evidence keeps a complete historical workflow snapshot", async () => {
  const evidence = JSON.parse(
    await readFile(resolve(repository, "docs/tests/evidence/2026-08-28-clean-mcp-clients.json"), "utf8"),
  ) as { clients?: Array<{ name?: string; workflow?: { tools?: unknown[] } }> };

  assert.deepEqual(evidence.clients?.map((client) => client.name), ["Codex", "Claude Code"]);
  for (const client of evidence.clients ?? []) assert.equal(client.workflow?.tools?.length, 6);
});

test("clean MCP client instructions document both supported registration paths", async () => {
  const documentation = await readFile(resolve(repository, "docs/tests/clean-mcp-clients.md"), "utf8");
  const readme = await readFile(resolve(repository, "docs/tests/README.md"), "utf8");
  const packageManifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  for (const expected of [
    "codex plugin marketplace add morshoto/framekit",
    "codex plugin add framekit@framekit",
    "claude mcp add --env FRAMEKIT_EDITOR=final-cut-live",
    "--scope user --transport stdio framekit",
    "npx -y @morshoto/framekit",
    "FRAMEKIT_CLEAN_CLIENT",
    "CAPABILITY_UNAVAILABLE",
    "no repository checkout",
    "releaseCandidate",
    "machine-readable",
    "NO_GO",
    "sanitized",
  ]) {
    assert.match(documentation, new RegExp(escapeRegExp(expected), "i"));
  }
  assert.doesNotMatch(documentation, /mcp --editor final-cut-live/);
  assert.match(readme, /clean MCP client/i);
  assert.equal(packageManifest.scripts?.["test:clean-mcp-clients"], "node scripts/clean-mcp-client-smoke.mjs");
});

function rawEvidence() {
  return {
    schemaVersion: 1,
    recordedAt: "2026-08-28T00:00:00.000Z",
    framekit: { version: "0.1.0", packageName: "@morshoto/framekit" },
    runtime: { version: "0.1.0", packageName: "@framekit/runtime" },
    environment: {
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceClean: true,
      nodeVersion: "v22.23.1",
      platform: "darwin",
      architecture: "arm64",
    },
    clients: [
      client("Codex", "0.144.1", "codex plugin marketplace add morshoto/framekit"),
      client("Claude Code", "2.1.231", "claude mcp add --scope user framekit"),
    ],
    privatePath: "/Users/private/secret-footage.mov",
    transactionId: "transaction-secret",
    diagnostics: "raw crash dump",
    apiKey: "api-key",
  };
}

function client(name: string, clientVersion: string, registrationCommand: string) {
  const privateMediaPath = `/${["Users", "private", "secret-footage.mov"].join("/")}`;
  return {
    name,
    clientVersion,
    registration: {
      status: "passed",
      command: registrationCommand,
      privateConfigPath: "/Users/private/.config/client.json",
    },
    server: { version: "0.1.0", protocolVersion: "2025-11-25" },
    editor: { name: "In-memory Editor", version: "phase-2-fixture", backend: "fixture" },
    capabilities: {
      editor: {
        canonicalTimelineMode: "canonical-write",
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: true,
        readAfterWrite: true,
        rollback: true,
      },
      analyzers: { speechTranscribe: true, audioLoudness: false, visualTrack: false },
    },
    workflow: {
      tools: [
        { name: "headless.project.create", status: "passed", raw: { source: privateMediaPath } },
        { name: "headless.project.inspect", status: "passed" },
        { name: "speech.analyze", status: "passed" },
        { name: "headless.edit.preview", status: "passed" },
        { name: "headless.edit.execute", status: "passed" },
        { name: "editing.route", status: "headless-selected" },
      ],
      limitations: [
        "CAPABILITY_UNAVAILABLE: native Final Cut mutation in headless mode",
        "CAPABILITY_UNAVAILABLE: published npm package is not available",
      ],
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
