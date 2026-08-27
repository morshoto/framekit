import { readFile } from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeCanonicalReadEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const expectedSequence = process.env.FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID;

if (!expectedProject) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT before running the canonical headed read E2E");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-canonical-read-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const mode = editor.capabilities?.editor?.canonicalTimelineMode;
  if (mode !== "canonical-read" && mode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${mode ?? "unknown"}; canonical-read is required`);
  }

  const catalog = await callJson("project.list");
  if (catalog.activeProjectId === undefined || catalog.activeSequenceId === undefined) {
    throw new Error("TARGET_UNAVAILABLE: active project and sequence identities are required");
  }
  const project = catalog.projects?.find(({ id }) => id === catalog.activeProjectId);
  if (!project) throw new Error("TARGET_MISMATCH: active project is absent from the project catalog");
  if (project.name !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${project.name}`);
  }
  if (!expectedSequence && project.sequences?.length !== 1) {
    throw new Error("AMBIGUOUS_PROJECT_TARGET: set FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID for a multi-sequence project");
  }
  if (expectedSequence && catalog.activeSequenceId !== expectedSequence) {
    throw new Error(`FINAL_CUT_E2E_SEQUENCE_MISMATCH: expected ${expectedSequence}, observed ${catalog.activeSequenceId}`);
  }
  const sequence = project.sequences?.find(({ id }) => id === catalog.activeSequenceId);
  if (!sequence) throw new Error("TARGET_MISMATCH: active sequence is absent from the active project");

  const snapshot = await callJson("project.inspect");
  if (snapshot.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${snapshot.projectName ?? "unknown"}`);
  }
  if (snapshot.projectId !== catalog.activeProjectId || snapshot.timeline?.id !== catalog.activeSequenceId) {
    throw new Error("TARGET_MISMATCH: canonical snapshot does not match the active catalog target");
  }

  const evidence = sanitizeCanonicalReadEvidence({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    project: { id: project.id, name: project.name, sequenceId: sequence.id },
    catalog,
    snapshot,
  }, await evidenceEnvironment());
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${text}`);
  }
}

async function evidenceEnvironment() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const gitCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) throw new Error("FINAL_CUT_E2E_COMMIT_UNAVAILABLE: git returned an invalid commit");
  const finalCutVersion = (await execFile("osascript", ["-e", 'tell application "Final Cut Pro" to get version'])).stdout.trim();
  if (!finalCutVersion) throw new Error("FINAL_CUT_E2E_FINAL_CUT_VERSION_UNAVAILABLE: Final Cut Pro returned an empty version");
  return {
    framekitVersion: packageJson.version,
    finalCutVersion,
    gitCommit,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
}
