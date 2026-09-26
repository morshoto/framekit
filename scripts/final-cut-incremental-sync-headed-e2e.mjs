import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceEnvironment, sanitizeIncrementalSyncEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = requireEnvironment("FRAMEKIT_FINAL_CUT_E2E_PROJECT");
const expectedProjectId = requireEnvironment("FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID");
const expectedSequenceId = requireEnvironment("FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID");
if (process.env.FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT !== "1") {
  throw new Error("FINAL_CUT_E2E_EXTERNAL_EDIT_CONSENT_REQUIRED: set FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT=1 for the disposable human-edit step");
}
const { createTimelineIrFromProjectSnapshot } = await import("@framekit/runtime");

const stateDirectory = await mkdtemp(join(tmpdir(), "framekit-v013-incremental-sync-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
    FRAMEKIT_STATE_DIR: stateDirectory,
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-incremental-sync-headed-e2e", version: "0.1.0" });
let prompt;

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const mode = editor.capabilities?.editor?.canonicalTimelineMode;
  if (mode !== "canonical-read" && mode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${mode ?? "unknown"}; canonical-read is required`);
  }

  const catalog = await callJson("project.list");
  assert(catalog.activeProjectId === expectedProjectId, "active project does not match the configured stable project ID");
  assert(catalog.activeSequenceId === expectedSequenceId, "active sequence does not match the configured stable sequence ID");
  const project = catalog.projects?.find(({ id }) => id === expectedProjectId);
  assert(project, `configured project ${expectedProjectId} is absent from the catalog`);
  assert(project.name === expectedProject, `expected project ${expectedProject}, observed ${project.name}`);
  assert(project.sequences?.some(({ id }) => id === expectedSequenceId), "configured sequence is absent from the configured project");
  assert(catalog.provenance?.reconciliation?.status === "matched", "project catalog reconciliation is not matched");
  assert(catalog.provenance.reconciliation.project.method === "stable-id", "project reconciliation did not use stable identity");
  assert(catalog.provenance.reconciliation.sequence.method === "stable-id", "sequence reconciliation did not use stable identity");

  const before = await callJson("project.inspect");
  assert(before.projectId === expectedProjectId, "canonical R0 project identity is wrong");
  assert(before.projectName === expectedProject, "canonical R0 project name is wrong");
  assert(before.timeline?.id === expectedSequenceId, "canonical R0 sequence identity is wrong");
  const context = await callJson("context.inspect");
  assert(sameRevision(context.revision, before.revision), "context R0 differs from canonical project R0");
  assert(context.cursor?.target?.projectId === expectedProjectId, "context cursor project target is wrong");
  assert(context.cursor?.target?.sequenceId === expectedSequenceId, "context cursor sequence target is wrong");

  const provider = { id: "final-cut", version: editor.identity?.version };
  const sessionId = `framekit-qa-${Date.now()}`;
  const created = await callJson("session.create", {
    sessionId,
    provider,
    base: createTimelineIrFromProjectSnapshot(before, provider),
  });

  prompt = createInterface({ input, output });
  await prompt.question(
    `R0=${before.revision.id} bound to ${expectedProject}/${expectedSequenceId}. `
      + "Make one controlled timeline edit in this disposable Final Cut project "
      + "(rename a clip or add a marker, without switching targets), then press Enter. ",
  );

  await callJson("editor.native.focus");
  const after = await callJson("project.inspect");
  assert(after.projectId === expectedProjectId, "canonical R1 project identity changed");
  assert(after.projectName === expectedProject, "canonical R1 project name changed");
  assert(after.timeline?.id === expectedSequenceId, "canonical R1 sequence identity changed");
  assert(after.revision?.sequence > before.revision?.sequence, "the controlled human edit did not advance the provider revision");

  const timelineChanges = await callJson("timeline.changes", {
    projectId: expectedProjectId,
    sequenceId: expectedSequenceId,
    revision: before.revision,
  });
  const contextChanges = await callJson("context.changes", { cursor: context.cursor });

  const stale = await callJson("session.status", { sessionId });
  const operation = {
    type: "add-marker",
    marker: {
      id: `framekit-qa-marker-${Date.now()}`,
      name: "Framekit QA session marker",
      startTime: { value: "0", timescale: "1" },
      durationTime: { value: "0", timescale: "1" },
    },
  };
  const blocked = await callSessionError("session.edit.preview", {
    sessionId,
    operations: [operation],
  });
  const providerState = createTimelineIrFromProjectSnapshot(after, provider);
  const reconciled = await callJson("session.reconcile", {
    sessionId,
    provider,
    providerState,
  });
  assert(reconciled.reconciliation?.status === "rebased", "session reconciliation did not rebase cleanly");
  const resumed = await callJson("session.edit.execute", {
    sessionId,
    operations: [operation],
  });

  const evidence = sanitizeIncrementalSyncEvidence({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    target: {
      projectId: expectedProjectId,
      projectName: expectedProject,
      sequenceId: expectedSequenceId,
    },
    revisions: { before: before.revision, after: after.revision },
    timelineChanges,
    contextChanges,
    session: {
      createdState: created.document?.state,
      staleState: stale.state,
      blockedCode: blocked.code,
      reconciledState: reconciled.document?.state,
      resumedState: resumed.document?.state,
      baseRevision: created.document?.base?.revision,
      providerRevision: reconciled.document?.base?.revision,
    },
  }, await evidenceEnvironment(root));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  prompt?.close();
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await rm(stateDirectory, { recursive: true, force: true });
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

async function callSessionError(name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded`);
  const payload = JSON.parse(text);
  assert(payload.code === "RECONCILIATION_REQUIRED", `${name} returned ${payload.code ?? "unknown"}, expected RECONCILIATION_REQUIRED`);
  return payload;
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`FINAL_CUT_E2E_ARGUMENT_INVALID: ${name} is required`);
  return value;
}

function sameRevision(left, right) {
  return left?.id === right?.id && left?.sequence === right?.sequence && left?.timestamp === right?.timestamp;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FINAL_CUT_E2E_INCREMENTAL_SYNC_FAILED: ${message}`);
}
