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
  if (capabilities?.projectCatalogRead !== true || capabilities.projectSelection !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: live project selection requires projectCatalogRead and projectSelection");
  }

  const catalog = await callJson("project.list");
  if (!Array.isArray(catalog.projects)) throw new Error("FINAL_CUT_E2E_PROJECT_CATALOG_INVALID: projects must be an array");
  const project = catalog.projects.find((candidate) => candidate?.id === expectedProjectId);
  if (!project) throw new Error(`FINAL_CUT_E2E_PROJECT_NOT_FOUND: ${expectedProjectId}`);
  if (!Array.isArray(project.sequences)) throw new Error("FINAL_CUT_E2E_PROJECT_CATALOG_INVALID: project sequences must be an array");

  const sequenceId = requestedSequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
  if (!sequenceId) throw new Error("AMBIGUOUS_PROJECT_TARGET: set FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID for a multi-sequence project");
  if (!project.sequences.some((sequence) => sequence?.id === sequenceId)) {
    throw new Error(`FINAL_CUT_E2E_SEQUENCE_NOT_FOUND: ${sequenceId} is not in ${expectedProjectId}`);
  }

  const selected = await callJson("project.select", { projectId: expectedProjectId, sequenceId });
  if (selected.activeProjectId !== expectedProjectId || selected.activeSequenceId !== sequenceId) {
    throw new Error("FINAL_CUT_E2E_PROJECT_SELECTION_FAILED: live catalog did not confirm the requested project and sequence");
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
    },
    selection: {
      projectId: expectedProjectId,
      sequenceId,
      catalogProjectCount: catalog.projects.length,
      selectedActiveProjectId: selected.activeProjectId,
      selectedActiveSequenceId: selected.activeSequenceId,
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
