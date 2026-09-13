import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceFromPreflight } from "./non-frontmost-evidence.mjs";

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const separator = String.fromCharCode(31);
const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event><project uid="background-regression-project" name="Background Regression">
    <sequence uid="background-regression-sequence" duration="1s"><spine>
      <asset-clip id="background-regression-clip" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

if (process.platform !== "darwin") {
  throw new Error("CAPABILITY_UNAVAILABLE: frontmost and focus probes require macOS");
}

const directory = await mkdtemp(join(os.tmpdir(), "framekit-background-regression-"));
const artifactPath = join(directory, "project.fcpxml");
await writeFile(artifactPath, FCPXML);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "apps/mcp-server/src/main.ts")],
  env: {
    ...process.env,
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_FCPXML_PATH: artifactPath,
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_AUTO_CONNECT: "0",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-background-regression-headed-e2e", version: "0.1.0" });
const beforeUi = await frontmostState();

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const evidence = evidenceFromPreflight(editor.preflight);
  if (evidence.evidenceTier !== "artifact" || evidence.processMode !== "headless") {
    throw new Error("NON_FRONTMOST_EVIDENCE_INVALID: background artifact workflow must remain headless artifact evidence");
  }
  if (editor.preflight.documentMode !== "fcpxml-artifact") {
    throw new Error("NON_FRONTMOST_DOCUMENT_MODE_INVALID: expected fcpxml-artifact document mode");
  }
  if (editor.workflows?.artifact?.requiresFinalCutFrontmost !== false) {
    throw new Error("NON_FRONTMOST_WORKFLOW_INVALID: artifact workflow must not require Final Cut frontmost");
  }
  const nativeFlags = Object.entries(editor.native ?? {})
    .filter(([key]) => !["requiresAccessibility", "requiresFinalCutFrontmost"].includes(key));
  if (nativeFlags.some(([, value]) => value === true)) {
    throw new Error("NON_FRONTMOST_NATIVE_UI_ENABLED: background regression must disable native UI writes");
  }

  const toolResults = [{ name: "editor.inspect", status: "passed" }];
  const catalog = await callJson("project.list");
  toolResults.push({ name: "project.list", status: "passed" });
  if (catalog.activeProjectId !== "fcpxml:project:background-regression-project") {
    throw new Error("NON_FRONTMOST_CATALOG_INVALID: disposable project was not listed");
  }

  const artifact = await callJson("artifact.inspect");
  toolResults.push({ name: "artifact.inspect", status: "passed" });
  const before = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  const preview = await callJson("artifact.edit.preview", {
    artifactPath,
    baseRevision: before.revision,
    operations: [{ type: "rename-clip", clipId: "background-regression-clip", name: "Background rename" }],
  });
  toolResults.push({ name: "artifact.edit.preview", status: "passed" });
  const executed = await callJson("artifact.edit.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "artifact.edit.execute", status: executed.status });
  if (executed.status !== "VERIFIED" || executed.artifact?.mutatesOpenTimeline !== false) {
    throw new Error("NON_FRONTMOST_ARTIFACT_EXECUTION_FAILED: artifact edit was not verified as background-safe");
  }
  const diff = await callJson("artifact.edit.diff", { artifactPath, transactionId: executed.id });
  toolResults.push({ name: "artifact.edit.diff", status: "passed" });
  const verification = await callJson("artifact.edit.verify", { artifactPath, transactionId: executed.id });
  toolResults.push({ name: "artifact.edit.verify", status: "passed" });
  const undone = await callJson("artifact.edit.undo", { artifactPath, transactionId: executed.id });
  toolResults.push({ name: "artifact.edit.undo", status: "passed" });
  if (diff.provenance?.surface !== "artifact" || verification.provenance?.revisionScope !== "artifact") {
    throw new Error("NON_FRONTMOST_PROVENANCE_INVALID: artifact readback lost source provenance");
  }
  if (undone.provenance?.mutatesOpenTimeline !== false) {
    throw new Error("NON_FRONTMOST_UNDO_INVALID: artifact undo must not change the open timeline");
  }

  const nativeBlocker = await callJson("editor.native.inspect");
  toolResults.push({ name: "editor.native.inspect", status: "passed" });
  if (nativeBlocker.error?.code !== "CAPABILITY_UNAVAILABLE") {
    throw new Error("NON_FRONTMOST_NATIVE_BLOCKER_INVALID: disabled native writes must fail closed");
  }

  const afterUi = await frontmostState();
  if (JSON.stringify(beforeUi) !== JSON.stringify(afterUi)) {
    throw new Error("NON_FRONTMOST_FOCUS_CHANGED: background-safe MCP calls changed frontmost or focus state");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceType: "non-frontmost-background-regression",
    passed: true,
    evidenceTier: evidence.evidenceTier,
    provider: evidence.provider,
    documentMode: evidence.documentMode,
    processMode: evidence.processMode,
    toolResults,
    nativeBlocker: {
      status: "CAPABILITY_UNAVAILABLE",
      bounded: true,
    },
    uiSafety: {
      frontmostUnchanged: true,
      timelineFocusUnchanged: beforeUi.timelineFocused === afterUi.timelineFocused,
      dialogsOpened: false,
      mcpNativeUi: "disabled",
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["artifact paths", "raw snapshots", "transaction identifiers", "window names", "diagnostics"],
    },
    artifact: {
      format: artifact.format,
      mutationStatus: executed.status,
      restored: undone.provenance?.mutatesOpenTimeline === false,
    },
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
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

async function frontmostState() {
  const script = `
tell application "System Events"
  set frontmostProcess to first application process whose frontmost is true
  tell frontmostProcess
    set processName to name as text
    set windowName to ""
    set windowRole to ""
    set focusedName to ""
    set focusedRole to ""
    set focusedDescription to ""
    try
      set focusedWindow to value of attribute "AXFocusedWindow"
      set windowName to name of focusedWindow as text
      set windowRole to role of focusedWindow as text
    end try
    try
      set focusedElement to value of attribute "AXFocusedUIElement"
      set focusedName to name of focusedElement as text
      set focusedRole to role of focusedElement as text
      set focusedDescription to description of focusedElement as text
    end try
    return processName & (ASCII character 31) & windowName & (ASCII character 31) & windowRole & (ASCII character 31) & focusedName & (ASCII character 31) & focusedRole & (ASCII character 31) & focusedDescription
  end tell
end tell`;
  const { stdout } = await execFile("osascript", ["-e", script]);
  const [processName, windowName, windowRole, focusedName, focusedRole, focusedDescription] = stdout.trim().split(separator);
  const focusText = [windowName, focusedName, focusedRole, focusedDescription].join(" ");
  return {
    frontmostApplication: processName,
    focusedWindowRole: windowRole || "unknown",
    focusedElementRole: focusedRole || "unknown",
    timelineFocused: processName === "Final Cut Pro" && /timeline/i.test(focusText),
    dialogOpen: /AXDialog|AXSheet/i.test(`${windowRole} ${focusedRole}`),
  };
}
