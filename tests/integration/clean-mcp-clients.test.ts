import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { sanitizeCleanMcpEvidence } from "../../scripts/clean-mcp-client-evidence.mjs";
import {
  digestCodexPluginDirectory,
  inspectInstalledCodexPlugin,
  isInstalledCodexPluginBoundToCandidate,
} from "../../scripts/codex-plugin-identity.mjs";
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
    "inspectInstalledCodexPlugin",
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

test("clean MCP evidence rejects a run marked as failed", () => {
  const failed = rawEvidence();
  failed.passed = false;

  assert.throws(
    () => sanitizeCleanMcpEvidence(failed),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: clean MCP workflow did not pass/,
  );
});

test("clean MCP evidence leaves an unverified plugin commit unknown", () => {
  const raw = rawEvidence();
  Object.assign(raw.clients[0]!.registration, { plugin: { version: "0.1.0" } });

  const evidence = sanitizeCleanMcpEvidence(raw);

  assert.deepEqual(evidence.clients[0]?.registration.plugin, { version: "0.1.0" });
  const candidateCommit = raw.environment.gitCommit;
  const candidate = assessReleaseCandidate({
    target: { version: "0.1.0", commit: candidateCommit },
    artifacts: {
      npmPackage: { available: true, version: "0.1.0", commit: candidateCommit },
      codexPlugin: { installed: true, version: "0.1.0" },
      mcpServer: { connected: true, version: "0.1.0", commit: candidateCommit },
      nativeExtension: {
        verified: true,
        version: "0.1.0",
        commit: candidateCommit,
        signed: true,
        checksumVerified: true,
      },
    },
  });
  assert.equal(candidate.status, "NO_GO");
  assert.equal(candidate.artifacts.codexPlugin.status, "NO_GO");
});

test("clean MCP evidence rejects a plugin commit detached from installed content", () => {
  const raw = rawEvidence();
  const commit = raw.environment.gitCommit;
  Object.assign(raw.clients[0]!.registration, {
    plugin: {
      version: "0.1.0",
      commit,
      sourceCommit: commit,
      identitySource: "installed-content-equals-clean-source",
      contentDigest: "a".repeat(64),
      sourceContentDigest: "b".repeat(64),
    },
  });

  assert.throws(
    () => sanitizeCleanMcpEvidence(raw),
    /plugin commit is not bound to matching installed content/,
  );
});

test("installed Codex plugin identity binds bytes to a clean source commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-installed-plugin-"));
  try {
    const codexHome = join(directory, "codex-home");
    const sourcePath = join(directory, "source", "plugins", "framekit");
    const installedPath = join(codexHome, "plugins", "cache", "framekit", "framekit", "0.1.0");
    const pluginManifest = JSON.stringify({ name: "framekit", version: "0.1.0" });
    for (const pluginPath of [sourcePath, installedPath]) {
      await mkdir(join(pluginPath, ".codex-plugin"), { recursive: true });
      await mkdir(join(pluginPath, "skills", "framekit"), { recursive: true });
      await writeFile(join(pluginPath, ".codex-plugin", "plugin.json"), pluginManifest);
      await writeFile(join(pluginPath, "skills", "framekit", "SKILL.md"), "Installed plugin contract");
      await writeFile(join(pluginPath, ".mcp.json"), '{"mcpServers":{}}');
    }

    const commit = "a".repeat(40);
    const identity = await inspectInstalledCodexPlugin({
      installedPath,
      sourcePath,
      codexHome,
      version: "0.1.0",
      sourceCommit: commit,
      sourceClean: true,
    });

    assert.equal(identity.commit, commit);
    assert.equal(identity.sourceCommit, commit);
    assert.equal(identity.identitySource, "installed-content-equals-clean-source");
    assert.match(identity.contentDigest, /^[0-9a-f]{64}$/);
    assert.equal(identity.contentDigest, identity.sourceContentDigest);
    assert.equal(isInstalledCodexPluginBoundToCandidate(identity, identity.sourceContentDigest, commit), true);
    assert.equal(isInstalledCodexPluginBoundToCandidate(identity, "d".repeat(64), commit), false);
    assert.equal(isInstalledCodexPluginBoundToCandidate(identity, identity.sourceContentDigest, "e".repeat(40)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex plugin digest ordering does not depend on locale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-plugin-digest-order-"));
  const pluginPath = join(directory, "plugin");
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    await mkdir(join(pluginPath, "z"), { recursive: true });
    await mkdir(join(pluginPath, "a"), { recursive: true });
    await mkdir(join(pluginPath, "é"), { recursive: true });
    await writeFile(join(pluginPath, "z", "last.txt"), "last");
    await writeFile(join(pluginPath, "a", "first.txt"), "first");
    await writeFile(join(pluginPath, "é", "accented.txt"), "accented");

    String.prototype.localeCompare = function localeCompareDisabled() {
      throw new Error("locale-dependent comparison must not be used");
    };

    await assert.doesNotReject(() => digestCodexPluginDirectory(pluginPath));
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed Codex plugin does not inherit a source commit when bytes or cleanliness differ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-plugin-mismatch-"));
  try {
    const codexHome = join(directory, "codex-home");
    const sourcePath = join(directory, "source", "plugins", "framekit");
    const installedPath = join(codexHome, "plugins", "cache", "framekit", "framekit", "0.1.0");
    for (const pluginPath of [sourcePath, installedPath]) {
      await mkdir(join(pluginPath, ".codex-plugin"), { recursive: true });
      await writeFile(join(pluginPath, ".codex-plugin", "plugin.json"), '{"name":"framekit","version":"0.1.0"}');
    }
    await writeFile(join(sourcePath, "SKILL.md"), "source skill");
    await writeFile(join(installedPath, "SKILL.md"), "different installed skill");

    const mismatched = await inspectInstalledCodexPlugin({
      installedPath,
      sourcePath,
      codexHome,
      version: "0.1.0",
      sourceCommit: "b".repeat(40),
      sourceClean: true,
    });
    assert.equal(mismatched.commit, undefined);
    assert.equal(mismatched.identitySource, "installed-content-differs-from-source");
    assert.notEqual(mismatched.contentDigest, mismatched.sourceContentDigest);

    await writeFile(join(installedPath, "SKILL.md"), "source skill");
    const dirty = await inspectInstalledCodexPlugin({
      installedPath,
      sourcePath,
      codexHome,
      version: "0.1.0",
      sourceCommit: "b".repeat(40),
      sourceClean: false,
    });
    assert.equal(dirty.contentDigest, dirty.sourceContentDigest);
    assert.equal(dirty.commit, undefined);

    await assert.rejects(inspectInstalledCodexPlugin({
      installedPath: sourcePath,
      sourcePath,
      codexHome,
      version: "0.1.0",
      sourceCommit: "b".repeat(40),
      sourceClean: true,
    }), /installed plugin path is outside the isolated Codex home/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clean MCP evidence preserves installed Codex plugin content provenance", () => {
  const raw = rawEvidence();
  const commit = raw.environment.gitCommit;
  const digest = "c".repeat(64);
  Object.assign(raw.clients[0]!.registration, {
    plugin: {
      version: "0.1.0",
      commit,
      sourceCommit: commit,
      identitySource: "installed-content-equals-clean-source",
      contentDigest: digest,
      sourceContentDigest: digest,
    },
  });

  const evidence = sanitizeCleanMcpEvidence(raw);
  assert.deepEqual(evidence.clients[0]?.registration.plugin, {
    version: "0.1.0",
    commit,
    sourceCommit: commit,
    identitySource: "installed-content-equals-clean-source",
    contentDigest: digest,
    sourceContentDigest: digest,
  });
});

test("clean MCP evidence reports package fingerprints and release artifact GO or NO_GO states", () => {
	const raw = rawEvidence() as ReturnType<typeof rawEvidence> & { releaseCandidate?: unknown };
	const candidateCommit = raw.environment.gitCommit;
	const pluginDigest = "d".repeat(64);
	Object.assign(raw.clients[0]!.registration, {
		plugin: {
			version: "0.1.0",
			commit: candidateCommit,
			sourceCommit: candidateCommit,
			identitySource: "installed-content-equals-clean-source",
			contentDigest: pluginDigest,
			sourceContentDigest: pluginDigest,
		},
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
			codexPlugin: {
				installed: true,
				version: "0.1.0",
				commit: candidateCommit,
				sourceCommit: candidateCommit,
				identitySource: "installed-content-equals-clean-source",
				contentDigest: pluginDigest,
				sourceContentDigest: pluginDigest,
			},
			mcpServer: { connected: true, version: "0.1.0", commit: candidateCommit },
			nativeExtension: { verified: false, reason: "signed native assets are not available" },
		},
	});

	const evidence = sanitizeCleanMcpEvidence(raw);
	assert.equal(evidence.clients[0]?.server.buildFingerprint?.commit, candidateCommit);
	assert.equal(evidence.clients[0]?.registration.plugin?.commit, candidateCommit);
	assert.equal(evidence.releaseCandidate?.artifacts.codexPlugin.contentDigest, pluginDigest);
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

test("sanitized clean MCP fixture keeps a complete historical workflow snapshot", async () => {
  const evidence = JSON.parse(
    await readFile(resolve(repository, "tests/fixtures/release-evidence/clean-mcp-clients-2026-08-28.json"), "utf8"),
  ) as { clients?: Array<{ name?: string; workflow?: { tools?: unknown[] } }> };

  assert.deepEqual(evidence.clients?.map((client) => client.name), ["Codex", "Claude Code"]);
  for (const client of evidence.clients ?? []) assert.equal(client.workflow?.tools?.length, 6);
});

test("issue 521 pretag evidence records a passing clean workflow and release blockers", async () => {
  const evidencePath = "tests/fixtures/release-evidence/issue-521-clean-mcp-pretag-2026-10-24.json";
  const evidence = JSON.parse(await readFile(resolve(repository, evidencePath), "utf8")) as {
    passed?: boolean;
    environment?: { gitCommit?: string; sourceClean?: boolean };
    clients?: Array<{
      name?: string;
      workflow?: {
        status?: string;
        delivery?: { nativeFinalCut?: { status?: string; reason?: string } };
      };
    }>;
    releaseCandidate?: {
      target?: { version?: string; commit?: string; sourceClean?: boolean };
      status?: string;
      artifacts?: Record<string, { status?: string; reason?: string }>;
    };
  };
  const artifacts = evidence.releaseCandidate?.artifacts ?? {};

  assert.equal(evidence.passed, true);
  assert.equal(evidence.environment?.sourceClean, true);
  assert.equal(evidence.releaseCandidate?.target?.version, "0.1.18");
  assert.equal(evidence.releaseCandidate?.target?.commit, evidence.environment?.gitCommit);
  assert.equal(evidence.releaseCandidate?.target?.sourceClean, true);
  assert.equal(evidence.releaseCandidate?.status, "NO_GO");
  assert.deepEqual(evidence.clients?.map((client) => [client.name, client.workflow?.status]), [["Codex", "passed"]]);
  assert.equal(evidence.clients?.[0]?.workflow?.delivery?.nativeFinalCut?.status, "blocked");
  assert.deepEqual(
    Object.values(artifacts).map((artifact) => artifact.status),
    ["NO_GO", "NO_GO", "NO_GO", "NO_GO"],
  );
  assert.match(artifacts.npmPackage?.reason ?? "", /0\.1\.18 is not published/);
  assert.match(artifacts.codexPlugin?.reason ?? "", /does not match target 0\.1\.18/);
  assert.match(artifacts.mcpServer?.reason ?? "", /does not match target 0\.1\.18/);
  assert.match(artifacts.nativeExtension?.reason ?? "", /signed native release provenance was not supplied/);

});

test("clean MCP client instructions document both supported registration paths", async () => {
  const gettingStarted = await readFile(resolve(repository, "docs/getting-started.md"), "utf8");
  const testing = await readFile(resolve(repository, "docs/testing.md"), "utf8");
  const documentation = `${gettingStarted}\n${testing}`;
  const readme = await readFile(resolve(repository, "README.md"), "utf8");
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
  assert.doesNotMatch(testing, /mcp --editor final-cut-live/);
  assert.match(readme, /\[Testing\]\(\.\/docs\/testing\.md\)/);
  assert.equal(packageManifest.scripts?.["test:clean-mcp-clients"], "node scripts/clean-mcp-client-smoke.mjs");
});

function rawEvidence() {
  return {
    schemaVersion: 1,
    passed: true,
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
