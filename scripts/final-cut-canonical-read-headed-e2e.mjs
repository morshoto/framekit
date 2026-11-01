import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceEnvironment, sanitizeCanonicalReadEvidence } from "./final-cut-evidence.mjs";
import { readBoundNativeProject } from "./final-cut-bound-native-read.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
    FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-canonical-read-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  const { catalog, project, sequence, snapshot } = await readBoundNativeProject(callJson, expectedProject, expectedSequence);
  const editor = await callJson("editor.inspect");
  const mode = editor.capabilities?.editor?.canonicalTimelineMode;
  if (mode !== "canonical-read" && mode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${mode ?? "unknown"}; canonical-read is required`);
  }

  const evidence = sanitizeCanonicalReadEvidence({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    project: { id: project.id, name: project.name, sequenceId: sequence.id },
    catalog,
    snapshot,
  }, await evidenceEnvironment(root));
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
