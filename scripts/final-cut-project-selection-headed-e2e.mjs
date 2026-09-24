import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evidenceEnvironment } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProjectId = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID;
const requestedSequenceId = process.env.FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID;

if (!expectedProjectId) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID before running the project-selection headed E2E");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FCPXML_PATH: "",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-project-selection-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const capabilities = editor.capabilities?.editor;
  if (
    capabilities?.projectCatalogRead !== true
    || capabilities.projectSelection !== true
    || !["background-capable", "headed-only"].includes(capabilities.projectSelectionMode)
  ) {
    throw new Error("CAPABILITY_UNAVAILABLE: live project selection requires projectCatalogRead and projectSelection");
  }

  const catalog = await callJson("project.list");
  if (!Array.isArray(catalog.projects)) throw new Error("FINAL_CUT_E2E_PROJECT_CATALOG_INVALID: projects must be an array");
  const project = catalog.projects.find((candidate) => candidate?.id === expectedProjectId);
  if (!project) throw new Error(`FINAL_CUT_E2E_PROJECT_NOT_FOUND: ${expectedProjectId}`);
  if (!Array.isArray(project.sequences)) throw new Error("FINAL_CUT_E2E_PROJECT_CATALOG_INVALID: project sequences must be an array");

  const reconciliation = catalog.provenance?.reconciliation;
  if (
    reconciliation?.status !== "matched"
    || reconciliation.project?.method !== "stable-id"
    || reconciliation.sequence?.method !== "stable-id"
    || reconciliation.project?.catalogId !== expectedProjectId
  ) {
    throw new Error("FINAL_CUT_E2E_RECONCILIATION_FAILED: project.list did not prove stable project and sequence identity reconciliation");
  }

  const sequenceId = requestedSequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
  if (!sequenceId) throw new Error("AMBIGUOUS_PROJECT_TARGET: set FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID for a multi-sequence project");
  if (!project.sequences.some((sequence) => sequence?.id === sequenceId)) {
    throw new Error(`FINAL_CUT_E2E_SEQUENCE_NOT_FOUND: ${sequenceId} is not in ${expectedProjectId}`);
  }
  if (reconciliation.sequence?.catalogId !== sequenceId) {
    throw new Error(`FINAL_CUT_E2E_RECONCILIATION_SEQUENCE_MISMATCH: reconciled sequence ${reconciliation.sequence?.catalogId ?? "<missing>"} does not match selected sequence ${sequenceId}`);
  }

  const live = await callJson("editor.live.inspect");
  if (
    live.project?.id !== reconciliation.project.liveId
    || live.sequence?.id !== reconciliation.sequence.liveId
    || live.project?.id === undefined
    || live.sequence?.id === undefined
  ) {
    throw new Error("FINAL_CUT_E2E_RECONCILIATION_LIVE_MISMATCH: live inspection did not match the reconciled identities");
  }

  const selected = await callJson("project.select", { projectId: expectedProjectId, sequenceId });
  if (
    selected.requestedTarget?.projectId !== expectedProjectId
    || selected.requestedTarget?.sequenceId !== sequenceId
    || selected.observedActiveTarget?.projectId !== expectedProjectId
    || selected.observedActiveTarget?.sequenceId !== sequenceId
    || typeof selected.observedRevision?.id !== "string"
    || !Number.isInteger(selected.observedRevision?.sequence)
  ) {
    throw new Error("FINAL_CUT_E2E_PROJECT_SELECTION_FAILED: live provider did not return target and revision evidence");
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: "headed-native-project-selection",
    passed: true,
    recordedAt: new Date().toISOString(),
    environment: await evidenceEnvironment(root),
    editor: {
      name: editor.identity?.name,
      version: editor.identity?.version,
      backend: editor.identity?.backend,
    },
    capabilities: {
      canonicalTimelineMode: capabilities.canonicalTimelineMode,
      projectCatalogRead: capabilities.projectCatalogRead,
      projectSelection: capabilities.projectSelection,
      projectSelectionMode: capabilities.projectSelectionMode,
    },
    selection: {
      projectId: expectedProjectId,
      sequenceId,
      catalogProjectCount: catalog.projects.length,
      selectedActiveProjectId: selected.activeProjectId,
      selectedActiveSequenceId: selected.activeSequenceId,
      requestedTarget: selected.requestedTarget,
      observedActiveTarget: selected.observedActiveTarget,
      observedRevision: {
        id: selected.observedRevision.id,
        sequence: selected.observedRevision.sequence,
      },
    },
    reconciliation: {
      status: reconciliation.status,
      project: {
        method: reconciliation.project.method,
        liveId: reconciliation.project.liveId,
        catalogId: reconciliation.project.catalogId,
      },
      sequence: {
        method: reconciliation.sequence.method,
        liveId: reconciliation.sequence.liveId,
        catalogId: reconciliation.sequence.catalogId,
      },
      liveInspection: {
        projectId: live.project.id,
        sequenceId: live.sequence.id,
        revision: {
          id: live.revision.id,
          sequence: live.revision.sequence,
        },
      },
    },
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function callJson(name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const output = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(output || `${name} failed`);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${output}`);
  }
}
