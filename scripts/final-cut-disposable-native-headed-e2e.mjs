import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sanitizeDisposableNativeEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const clipId = process.env.FRAMEKIT_FINAL_CUT_E2E_CLIP_ID;

if (!expectedProject || !clipId) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_CLIP_ID before running the disposable native headed E2E");
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
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "framekit-disposable-native-headed-e2e", version: "0.1.0" });
let operationId;

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  const toolResults = [{ name: "editor.inspect", status: "passed" }];
  const canonicalMode = editor.capabilities?.editor?.canonicalTimelineMode;
  if (canonicalMode !== "canonical-read" && canonicalMode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${canonicalMode ?? "unknown"}; canonical live reads are required`);
  }
  if (!editor.native?.selectionEdit || !editor.native?.undo) {
    throw new Error("CAPABILITY_UNAVAILABLE: native selection edit and Undo are required");
  }

  const before = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  if (before.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${before.projectName ?? "unknown"}`);
  }
  const target = before.timeline?.clips?.find((clip) => clip.id === clipId);
  if (!target) throw new Error(`FINAL_CUT_E2E_CLIP_MISMATCH: ${clipId} is not in the selected timeline`);
  const beforeDigest = canonicalDigest(before);
  const name = `${target.name} [Framekit Disposable E2E]`;

  const preview = await callJson("editor.native.disposable.preview", {
    clipId,
    name,
    baseRevision: before.revision,
  });
  toolResults.push({ name: "editor.native.disposable.preview", status: "passed" });
  if (preview.target?.clipId !== clipId || preview.baseRevision?.id !== before.revision?.id) {
    throw new Error("FINAL_CUT_E2E_DISPOSABLE_PREVIEW_FAILED: preview did not preserve the canonical target and revision");
  }

  const executed = await callJson("editor.native.disposable.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "editor.native.disposable.execute", status: executed.status });
  if (executed.status !== "VERIFIED" || executed.verification?.passed !== true) {
    throw new Error("FINAL_CUT_E2E_DISPOSABLE_EXECUTE_FAILED: live disposable edit was not verified");
  }
  if (executed.diff?.modified?.length !== 1 || executed.diff.modified[0]?.itemId !== clipId) {
    throw new Error("FINAL_CUT_E2E_DISPOSABLE_DIFF_FAILED: live disposable edit did not return the expected target diff");
  }
  operationId = executed.operationId;

  const undone = await callJson("editor.native.disposable.undo", { operationId });
  toolResults.push({ name: "editor.native.disposable.undo", status: "passed" });
  if (!undone.undone || undone.verification?.passed !== true || undone.restoredDigest !== beforeDigest) {
    throw new Error("FINAL_CUT_E2E_DISPOSABLE_ROLLBACK_FAILED: native Undo did not restore the pre-edit canonical digest");
  }
  operationId = undefined;

  const evidence = sanitizeDisposableNativeEvidence({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    nativeCapabilities: editor.native,
    project: { id: before.projectId, name: before.projectName, sequenceId: before.timeline.id },
    target: { occurrenceId: target.id, mediaId: target.mediaId },
    toolResults,
    executeStatus: executed.status,
    before,
    after: executed.after,
    restored: undone.restored,
    diff: executed.diff,
    digests: { before: executed.beforeDigest ?? beforeDigest, after: executed.afterDigest, restored: undone.restoredDigest },
    restoredVerification: undone.verification,
  }, await evidenceEnvironment());
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  if (operationId) {
    try {
      await callJson("editor.native.disposable.undo", { operationId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Disposable native headed E2E failed and compensating undo also failed");
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

function canonicalDigest(snapshot) {
  return createHash("sha256").update(stableJson({
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    timeline: snapshot.timeline,
    media: snapshot.media.map(({ mediaId, source }) => ({ mediaId, source })),
  })).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function evidenceEnvironment() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  let gitCommit;
  try {
    gitCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch (error) {
    throw new Error(`FINAL_CUT_E2E_COMMIT_UNAVAILABLE: ${String(error)}`);
  }
  if (!gitCommit) throw new Error("FINAL_CUT_E2E_COMMIT_UNAVAILABLE: git returned an empty commit");
  return {
    framekitVersion: packageJson.version,
    finalCutVersion: await finalCutVersion(),
    gitCommit,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
}

async function finalCutVersion() {
  try {
    const version = (await execFile("osascript", ["-e", 'tell application "Final Cut Pro" to get version'])).stdout.trim();
    if (version) return version;
  } catch (error) {
    throw new Error(`FINAL_CUT_E2E_FINAL_CUT_VERSION_UNAVAILABLE: ${String(error)}`);
  }
  throw new Error("FINAL_CUT_E2E_FINAL_CUT_VERSION_UNAVAILABLE: Final Cut Pro returned an empty version");
}
