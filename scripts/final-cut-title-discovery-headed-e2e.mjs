import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceEnvironment, sanitizeNativeTitleEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const titleQuery = process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY;
const titleText = process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_TEXT ?? "Framekit Native Title";
const duration = parseDuration(process.env.FRAMEKIT_FINAL_CUT_E2E_TITLE_DURATION ?? "3/1");

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Native Final Cut title discovery and placement E2E",
    "",
    "Required:",
    "  FRAMEKIT_FINAL_CUT_E2E_PROJECT=exact-disposable-project-name",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY=title-browser-search-query",
    "",
    "Optional:",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_TEXT=title-text",
    "  FRAMEKIT_FINAL_CUT_E2E_TITLE_DURATION=positive-value/timescale",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(0);
}

if (!expectedProject || !titleQuery) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_TITLE_QUERY before running the headed title E2E");
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
const client = new Client({ name: "framekit-title-discovery-headed-e2e", version: "0.1.0" });
let operationId;

try {
  const toolResults = [];
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  toolResults.push({ name: "editor.inspect", status: "passed" });
  if (editor.native?.titleDiscovery !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: native title discovery is not enabled");
  }
  if (editor.native?.titlePlacement !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: native title placement is not enabled");
  }
  if (editor.native?.requiresAccessibility !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: Accessibility permission is required");
  }
  if (editor.native?.requiresFinalCutFrontmost !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut must be frontmost");
  }
  if (editor.native?.project && editor.native.project !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${editor.native.project}`);
  }

  const assets = await callJson("editor.assets", { kind: "title", query: titleQuery });
  toolResults.push({ name: "editor.assets", status: "passed" });
  const title = Array.isArray(assets)
    ? assets.find((asset) => asset.id?.startsWith("final-cut:title:"))
    : undefined;
  if (!title) {
    throw new Error("FINAL_CUT_E2E_NATIVE_TITLE_NOT_FOUND: no provider-qualified native title matched the query");
  }
  if (title.metadata?.discovery?.backend !== "final-cut-accessibility"
    || title.metadata?.discovery?.guarantee !== "observed"
    || !title.metadata?.identity) {
    throw new Error("FINAL_CUT_E2E_NATIVE_TITLE_PROVENANCE_FAILED: discovery did not return native provenance and identity");
  }

  const preview = await callJson("editor.native.title.add.preview", {
    assetId: title.id,
    text: titleText,
    duration,
  });
  toolResults.push({ name: "editor.native.title.add.preview", status: "passed" });
  if (preview.asset?.id !== title.id || preview.target !== "playhead" || !preview.revision) {
    throw new Error("FINAL_CUT_E2E_TITLE_PREVIEW_FAILED: preview lost the discovered identity or live target");
  }

  const executed = await callJson("editor.native.title.add.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "editor.native.title.add.execute", status: executed.verification?.verified ? "passed" : "failed" });
  operationId = executed.operationId;
  if (!executed.verification?.verified
    || executed.asset?.id !== title.id
    || executed.beforeRevision?.id === executed.afterRevision?.id
    || !executed.undoAvailable
    || !executed.undoCommand) {
    throw new Error("FINAL_CUT_E2E_TITLE_PLACEMENT_FAILED: native title placement was not read-back verified");
  }

  const undone = await callJson("editor.native.undo", { operationId });
  toolResults.push({ name: "editor.native.undo", status: undone.verification?.verified === true ? "passed" : "failed" });
  if (!undone.undone || !undone.verification?.verified) {
    throw new Error("FINAL_CUT_E2E_TITLE_UNDO_FAILED: native Undo did not verify restoration");
  }
  operationId = undefined;

  const evidence = sanitizeNativeTitleEvidence({
    evidenceType: "headed-native-title-discovery-and-placement",
    passed: true,
    recordedAt: new Date().toISOString(),
    project: expectedProject,
    discovery: {
      id: title.id,
      name: title.name,
      vendor: title.vendor,
      identity: title.metadata.identity,
      backend: title.metadata.discovery.backend,
      guarantee: title.metadata.discovery.guarantee,
    },
    target: { sequenceId: preview.sequenceId },
    placement: {
      text: titleText,
      target: preview.target,
      start: preview.start,
      duration: preview.duration,
      beforeRevision: executed.beforeRevision.id,
      afterRevision: executed.afterRevision.id,
      undoRevision: undone.context?.revision?.id,
      verified: executed.verification.verified,
      undo: { command: executed.undoCommand, verified: undone.verification.verified },
    },
    toolResults,
  }, await evidenceEnvironment(root));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  if (operationId) {
    try {
      await callJson("editor.native.undo", { operationId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Native title headed E2E failed and compensating Undo also failed");
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

function parseDuration(value) {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match || match[2] === "0" || BigInt(match[1]) <= 0n) {
    throw new Error(`FINAL_CUT_E2E_DURATION_INVALID: expected a positive rational value/timescale, observed ${value}`);
  }
  return { value: match[1], timescale: match[2] };
}
