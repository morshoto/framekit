import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const clipId = process.env.FRAMEKIT_FINAL_CUT_E2E_CLIP_ID;

if (!expectedProject || !clipId) {
  throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT and FRAMEKIT_FINAL_CUT_E2E_CLIP_ID before running the canonical headed E2E");
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
const client = new Client({ name: "framekit-canonical-headed-e2e", version: "0.1.0" });
let transactionId;

try {
  await client.connect(transport);
  const editor = await callJson("editor.inspect");
  if (editor.capabilities?.editor?.canonicalTimelineMode !== "canonical-write") {
    throw new Error(`CAPABILITY_UNAVAILABLE: live bridge reported ${editor.capabilities?.editor?.canonicalTimelineMode ?? "unknown"}; canonical-write is required`);
  }

  const before = await callJson("project.inspect");
  if (before.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${before.projectName ?? "unknown"}`);
  }
  const target = before.timeline?.clips?.find((clip) => clip.id === clipId);
  if (!target) throw new Error(`FINAL_CUT_E2E_CLIP_MISMATCH: ${clipId} is not in the selected timeline`);
  const beforeDigest = canonicalDigest(before);

  const transaction = await callJson("timeline.edit", {
    type: "rename-clip",
    clipId,
    name: `${target.name} [Framekit E2E]`,
    baseRevision: before.revision,
  });
  transactionId = transaction.id;
  if (transaction.status !== "VERIFIED" || transaction.diff?.modified?.[0]?.itemId !== clipId) {
    throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: live edit did not return the expected verified diff");
  }

  const restored = await callJson("edit.undo", { transactionId });
  transactionId = undefined;
  const restoredDigest = canonicalDigest(restored);
  if (restoredDigest !== beforeDigest) {
    throw new Error("FINAL_CUT_E2E_ROLLBACK_DIGEST_MISMATCH: undo did not restore the pre-edit canonical digest");
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    recordedAt: new Date().toISOString(),
    editor: editor.identity,
    capabilities: editor.capabilities,
    project: { id: before.projectId, name: before.projectName, sequenceId: before.timeline.id },
    target: { occurrenceId: target.id, mediaId: target.mediaId },
    before,
    after: transaction.after,
    diff: transaction.diff,
    restored,
    digests: { before: beforeDigest, restored: restoredDigest },
  }, null, 2)}\n`);
} catch (error) {
  if (transactionId) {
    try {
      await callJson("edit.undo", { transactionId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Canonical headed E2E failed and compensating undo also failed");
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
