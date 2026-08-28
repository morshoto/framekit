import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { sanitizeCleanMcpEvidence } from "../../scripts/clean-mcp-client-evidence.mjs";

const repository = resolve(process.cwd());

test("clean MCP client runner covers the required setup and workflow", async () => {
  const runner = await readFile(resolve(repository, "scripts/clean-mcp-client-smoke.mjs"), "utf8");

  for (const expected of [
    "codex plugin marketplace add morshoto/framekit",
    "codex plugin add framekit@framekit",
    "claude mcp add",
    "connection.status",
    "project.inspect",
    "speech.analyze",
    "timeline.edit",
    "edit.diff",
    "edit.verify",
    "edit.undo",
    "@modelcontextprotocol/sdk",
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
    { name: "project.inspect", status: "passed" },
    { name: "speech.analyze", status: "passed" },
    { name: "timeline.edit", status: "VERIFIED" },
    { name: "edit.diff", status: "passed" },
    { name: "edit.verify", status: "passed" },
    { name: "edit.undo", status: "passed" },
  ]);
});

test("clean MCP evidence omits private paths, transaction IDs, and raw diagnostics", () => {
  const evidence = sanitizeCleanMcpEvidence(rawEvidence());
  const serialized = JSON.stringify(evidence);

  assert.doesNotMatch(serialized, /Users\/private|secret-footage|transaction-secret|raw crash dump|api-key/i);
  assert.match(serialized, /allowlisted-summary/);
  assert.match(serialized, /CAPABILITY_UNAVAILABLE/);
});

test("clean MCP evidence rejects incomplete client workflows", () => {
  const incomplete = rawEvidence();
  incomplete.clients[1]!.workflow.tools = incomplete.clients[1]!.workflow.tools.slice(0, 5);

  assert.throws(
    () => sanitizeCleanMcpEvidence(incomplete),
    /CLEAN_MCP_EVIDENCE_INCOMPLETE: Claude Code workflow is incomplete/,
  );
});

test("published clean MCP evidence documents the current validation result", async () => {
  const evidence = JSON.parse(
    await readFile(resolve(repository, "docs/tests/evidence/2026-08-27-clean-mcp-clients.json"), "utf8"),
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
    "claude mcp add --scope user --transport stdio framekit",
    "npx -y @morshoto/framekit",
    "FRAMEKIT_CLEAN_CLIENT",
    "CAPABILITY_UNAVAILABLE",
    "no repository checkout",
    "sanitized",
  ]) {
    assert.match(documentation, new RegExp(escapeRegExp(expected), "i"));
  }
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
        { name: "project.inspect", status: "passed", raw: { source: "/Users/private/secret-footage.mov" } },
        { name: "speech.analyze", status: "passed" },
        { name: "timeline.edit", status: "VERIFIED" },
        { name: "edit.diff", status: "passed" },
        { name: "edit.verify", status: "passed" },
        { name: "edit.undo", status: "passed" },
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
