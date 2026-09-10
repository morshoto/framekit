import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = process.env.FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH;
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PUBLISH_PROJECT;
const expectedSequence = process.env.FRAMEKIT_FINAL_CUT_E2E_PUBLISH_SEQUENCE;

if (process.argv.includes("--help")) {
  process.stdout.write([
    "FCPXML publisher headed Final Cut E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH=/absolute/path/to/disposable.fcpxml",
    "  FRAMEKIT_FINAL_CUT_E2E_PUBLISH_PROJECT=exact-imported-project-name",
    "Optional:",
    "  FRAMEKIT_FINAL_CUT_E2E_PUBLISH_SEQUENCE=exact-imported-sequence-name",
    "",
    "The artifact is edited and published as a new project; native editing is not exercised.",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!artifactPath || !expectedProject) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH and FRAMEKIT_FINAL_CUT_E2E_PUBLISH_PROJECT before running the publisher headed E2E");
}

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
let artifactTransactionId;
let published = false;

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

  const source = await callJson("project.inspect");
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

  const edited = await callJson("artifact.edit", {
    artifactPath,
    type: "add-marker",
    timelineId: source.timeline.id,
    marker: { id: "framekit-publisher-e2e", start: 0, duration: 0, name: "Framekit Publisher E2E" },
    baseRevision: source.revision,
  });
  if (edited.status !== "VERIFIED") {
    throw new Error("FINAL_CUT_E2E_PUBLISH_ARTIFACT_EDIT_FAILED: disposable artifact preparation was not verified");
  }
  artifactTransactionId = edited.id;

  const result = await callJson("artifact.publish", {
    artifactPath,
    transactionId: artifactTransactionId,
    confirm: true,
  });
  published = true;
  if (result.verified !== true || result.createdTarget?.projectName !== expectedProject) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_VERIFICATION_FAILED: publisher did not return the requested project identity");
  }
  if (result.createdTarget?.sequenceName !== (expectedSequence ?? sourceSequence)) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_SEQUENCE_VERIFICATION_FAILED: publisher did not return the requested sequence identity");
  }
  if (result.activeProject?.before?.id !== beforeLive.project.id || result.activeProject?.after?.id !== result.createdTarget?.projectId) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_TARGET_VERIFICATION_FAILED: active project identity was not changed to the imported project");
  }

  const afterLive = await callJson("editor.live.inspect");
  if (afterLive.project?.id !== result.createdTarget?.projectId || afterLive.sequence?.id !== result.createdTarget?.sequenceId) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_LIVE_STATE_MISMATCH: live state does not match the imported target");
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    workflow: "fcpxml-publisher",
    artifact: basename(artifactPath),
    sourceTarget: result.sourceTarget,
    createdTarget: result.createdTarget,
    activeProject: result.activeProject,
    beforeLive: { projectId: beforeLive.project.id, sequenceId: beforeLive.sequence.id },
    afterLive: { projectId: afterLive.project.id, sequenceId: afterLive.sequence.id },
  }, null, 2)}\n`);
} catch (error) {
  if (artifactTransactionId && !published) {
    try {
      await callJson("edit.undo", { transactionId: artifactTransactionId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Publisher headed E2E failed and artifact cleanup also failed");
    }
  }
  throw error;
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
