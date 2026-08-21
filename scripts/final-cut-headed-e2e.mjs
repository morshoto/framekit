import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const query = process.env.FRAMEKIT_FINAL_CUT_E2E_QUERY;

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Disposable headed Final Cut E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_PROJECT=exact-disposable-project-name",
    "  FRAMEKIT_FINAL_CUT_E2E_QUERY=browser-search-query",
    "",
    "The test searches, selects, locates, Blades, verifies two segments, and undoes.",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!expectedProject || !query) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_QUERY before running the headed E2E");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-headed-e2e", version: "0.1.0" });

try {
  await client.connect(transport);
  await activateFinalCut();
  const native = await callJson("editor.native.inspect");
  if (!native.available || !native.frontmost) {
    throw new Error(`FINAL_CUT_NATIVE_NOT_READY: ${native.error?.message ?? "Final Cut timeline is not frontmost"}`);
  }
  if (native.project !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${native.project ?? "none"}`);
  }

  const matches = await callJson("editor.native.media.search", { query });
  if (!Array.isArray(matches) || matches.length === 0) throw new Error("FINAL_CUT_E2E_MEDIA_NOT_FOUND: Browser search returned no results");
  const selected = matches[0];
  await callJson("editor.native.media.select", { mediaHandle: selected.handle });
  const located = await callJson("editor.native.timeline.locate", { mediaHandle: selected.handle });
  if (located.status !== "unique") {
    throw new Error(`FINAL_CUT_E2E_OCCURRENCE_${String(located.status).toUpperCase()}: expected exactly one timeline occurrence`);
  }
  const preview = await callJson("editor.native.blade.preview", { occurrenceHandle: located.occurrences[0].handle });
  const blade = await callJson("editor.native.blade.execute", { previewToken: preview.previewToken });
  if (!blade.verification?.verified || blade.resultingSegments?.length < 2) {
    throw new Error("FINAL_CUT_E2E_BLADE_VERIFICATION_FAILED: expected two resulting segments");
  }
  await callJson("editor.native.undo", { operationId: blade.operationId });
  const restored = await callJson("editor.native.timeline.locate", { mediaHandle: selected.handle });
  if (restored.status !== "unique") throw new Error("FINAL_CUT_E2E_UNDO_VERIFICATION_FAILED: original occurrence was not restored");

  process.stdout.write(JSON.stringify({
    passed: true,
    project: expectedProject,
    query,
    media: selected,
    bladeOperationId: blade.operationId,
    restored: true,
  }, null, 2));
  process.stdout.write("\n");
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

async function activateFinalCut() {
  try {
    await execFile("open", ["-a", "Final Cut Pro"]);
    await new Promise((resolve) => setTimeout(resolve, 750));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL_CUT_NATIVE_NOT_READY: could not activate Final Cut Pro: ${message}`);
  }
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
