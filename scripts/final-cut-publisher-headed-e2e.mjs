import { basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FcpxmlDocumentAdapter } from "../adapters/final-cut/typescript/src/fcpxml.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPublishStages, verifyAcceptanceFixture, verifyPublishedTarget } from "./final-cut-publisher-verification.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = process.env.FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH;
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PUBLISH_PROJECT;
const expectedSequence = process.env.FRAMEKIT_FINAL_CUT_E2E_PUBLISH_SEQUENCE;
const targetLibraryPath = process.env.FRAMEKIT_FINAL_CUT_E2E_LIBRARY_PATH;
const approvedDigest = process.env.FRAMEKIT_FINAL_CUT_E2E_APPROVED_DIGEST;
const executionId = process.env.FRAMEKIT_FINAL_CUT_E2E_EXECUTION_ID;

if (process.argv.includes("--help")) {
  process.stdout.write([
    "FCPXML publisher headed Final Cut E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH=/absolute/path/to/disposable.fcpxml",
    "  FRAMEKIT_FINAL_CUT_E2E_PUBLISH_PROJECT=exact-imported-project-name",
    "  FRAMEKIT_FINAL_CUT_E2E_LIBRARY_PATH=/absolute/path/to/new-library.fcpbundle",
    "  FRAMEKIT_FINAL_CUT_E2E_APPROVED_DIGEST=sha256-of-approved-artifact",
    "  FRAMEKIT_FINAL_CUT_E2E_EXECUTION_ID=verified-headless-rough-cut-execution-id",
    "  FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1 (separate authorization for import and readback)",
    "Optional:",
    "  FRAMEKIT_FINAL_CUT_E2E_PUBLISH_SEQUENCE=exact-imported-sequence-name",
    "",
    "The verified rough-cut artifact is published as a new project; native editing is not exercised.",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!artifactPath || !isAbsolute(artifactPath) || !expectedProject || !targetLibraryPath || !isAbsolute(targetLibraryPath) || !targetLibraryPath.endsWith(".fcpbundle") || !executionId || !/^[a-f0-9]{64}$/.test(approvedDigest ?? "") || process.env.FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION !== "1") {
  throw new Error("FINAL_CUT_E2E_AUTHORIZATION_REQUIRED: provide absolute artifact and new library paths, project, verified execution ID, approved SHA-256 and separate mutation authorization");
}
try {
  await stat(targetLibraryPath);
  throw new Error("FINAL_CUT_E2E_LIBRARY_EXISTS: destination must be new");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const actualDigest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
if (actualDigest !== approvedDigest) throw new Error("FINAL_CUT_E2E_APPROVED_DIGEST_MISMATCH: artifact differs from the approved digest; no import attempted");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: artifactPath,
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-publisher-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  if (editor.capabilities?.editor?.artifactPublish !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: artifact publishing is not advertised by the live editor");
  }

  const artifact = await callJson("artifact.inspect");
  if (artifact.path !== artifactPath || artifact.format !== "fcpxml") {
    throw new Error(`PUBLISH_TARGET_MISMATCH: expected managed FCPXML artifact ${artifactPath}`);
  }

  const source = await new FcpxmlDocumentAdapter(artifactPath).readProject();
  verifyAcceptanceFixture(source);
  if (source.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PUBLISH_PROJECT_MISMATCH: expected ${expectedProject}, observed ${source.projectName ?? "unknown"}`);
  }
  const sourceSequence = source.timeline?.name;
  if (expectedSequence && sourceSequence !== expectedSequence) {
    throw new Error(`FINAL_CUT_E2E_PUBLISH_SEQUENCE_MISMATCH: expected ${expectedSequence}, observed ${sourceSequence ?? "unknown"}`);
  }

  const beforeLive = await callJson("editor.live.inspect");
  if (!beforeLive.project?.id || !beforeLive.sequence?.id) {
    throw new Error("TARGET_UNAVAILABLE: live project and sequence identities are required before publish");
  }

  const job = await runPublishStages(callJson, {
    artifactPath, headlessExecutionId: executionId, targetLibraryPath, artifactDigest: approvedDigest,
  }, (stage, snapshot) => {
    process.stderr.write(`${JSON.stringify({ stage, jobId: snapshot.jobId, state: snapshot.state, artifactDigest: approvedDigest })}\n`);
  });
  const result = job.result;

  const afterLive = await callJson("editor.live.inspect");
  verifyPublishedTarget({ result, beforeLive, afterLive, expectedProject, expectedSequence, sourceSequence, targetLibraryPath });
  if (!(await stat(targetLibraryPath)).isDirectory()) throw new Error("FINAL_CUT_E2E_LIBRARY_MISSING: created library is not a directory");

  process.stdout.write(`${JSON.stringify({
    passed: true,
    workflow: "fcpxml-publisher",
    artifact: basename(artifactPath),
    sourceTarget: { kind: result.sourceTarget.kind, artifactPath: basename(result.sourceTarget.artifactPath) },
    createdTarget: result.createdTarget,
    activeProject: result.activeProject,
    semanticReadback: result.semanticReadback,
    sourceMediaIntegrity: { unchanged: result.sourceMediaIntegrity.unchanged, digests: result.sourceMediaIntegrity.digests.map(({ sha256 }) => sha256) },
    beforeLive: { projectId: beforeLive.project.id, sequenceId: beforeLive.sequence.id },
    afterLive: { projectId: afterLive.project.id, sequenceId: afterLive.sequence.id },
  }, null, 2)}\n`);
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
