import { readFile } from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { sanitizeDialogueNormalizationEvidence } from "./final-cut-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const expectedProject = process.env.FRAMEKIT_FINAL_CUT_E2E_PROJECT;
const occurrenceId = process.env.FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE;
const targetLufs = optionalNumber("FRAMEKIT_DIALOGUE_TARGET_LUFS", -16);
const toleranceDb = optionalNumber("FRAMEKIT_DIALOGUE_TOLERANCE_DB", 0.5);
const maxTruePeakDb = optionalNumber("FRAMEKIT_DIALOGUE_MAX_TRUE_PEAK_DB", -1);

if (!expectedProject) throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_PROJECT before running the dialogue-normalization headed E2E");
if (!occurrenceId) throw new Error("Set FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE before running the dialogue-normalization headed E2E");

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
const client = new Client({ name: "framekit-dialogue-normalization-headed-e2e", version: "0.1.0" });
let transactionId;
let canUndo = false;

try {
  await client.connect(transport);
  const toolResults = [];
  const editor = await callJson("editor.inspect");
  toolResults.push({ name: "editor.inspect", status: "passed" });
  requireDialogueCapabilities(editor);

  const inspection = await callJson("skill.inspect", { skill: "dialogue-normalization" });
  toolResults.push({ name: "skill.inspect", status: "passed" });
  if (inspection.availability?.available !== true) {
    throw new Error(`CAPABILITY_UNAVAILABLE: dialogue-normalization Skill requirements are unmet: ${JSON.stringify(inspection.availability?.missingRequirements ?? [])}`);
  }

  const live = await callJson("editor.live.inspect");
  toolResults.push({ name: "editor.live.inspect", status: "passed" });
  const before = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  if (before.projectName !== expectedProject) {
    throw new Error(`FINAL_CUT_E2E_PROJECT_MISMATCH: expected ${expectedProject}, observed ${before.projectName ?? "unknown"}`);
  }
  if (live.project?.id !== before.projectId || live.sequence?.id !== before.timeline.id) {
    throw new Error("FINAL_CUT_E2E_TARGET_MISMATCH: live state and canonical snapshot identify different targets");
  }
  const occurrence = before.timeline.clips.find((clip) => clip.id === occurrenceId);
  if (!occurrence) throw new Error(`FINAL_CUT_E2E_OCCURRENCE_MISMATCH: ${occurrenceId} is not in the active sequence`);

  const preview = await callJson("skill.preview", {
    skill: "dialogue-normalization",
    arguments: {
      baseRevision: before.revision,
      mediaId: occurrence.mediaId,
      occurrenceId,
      targetLufs,
      toleranceDb,
      maxTruePeakDb,
      minGainDb: -6,
      maxGainDb: 6,
      minDialogueDurationSeconds: 1,
    },
  });
  toolResults.push({ name: "skill.preview", status: "passed" });
  if (preview.plan?.decision !== "APPLY" || preview.plan.operations?.length !== 1) {
    throw new Error("FINAL_CUT_E2E_NO_DIALOGUE_GAIN: disposable occurrence did not produce one gain operation");
  }
  const details = preview.plan.details;
  const measurement = details?.measurement;
  if (!Number.isFinite(measurement?.integratedLufs) || !Number.isFinite(measurement?.truePeakDb)) {
    throw new Error("FINAL_CUT_E2E_MEASUREMENT_MISSING: preview omitted LUFS or true-peak evidence");
  }

  const execution = await callJson("skill.execute", { previewToken: preview.previewToken });
  toolResults.push({ name: "skill.execute", status: execution.status });
  transactionId = execution.transactionIds?.[0];
  if (execution.status !== "VERIFIED" || !transactionId) {
    throw new Error("FINAL_CUT_E2E_EDIT_VERIFICATION_FAILED: dialogue normalization was not verified");
  }
  const loudness = requirePassedCheck(execution, "dialogue-loudness");
  const peak = requirePassedCheck(execution, "dialogue-true-peak");
  canUndo = true;

  const after = await callJson("project.inspect");
  toolResults.push({ name: "project.inspect", status: "passed" });
  const restored = await callJson("edit.undo", { transactionId });
  toolResults.push({ name: "edit.undo", status: "passed" });
  canUndo = false;
  transactionId = undefined;
  const beforeDigest = canonicalDigest(before);
  const restoredDigest = canonicalDigest(restored);
  if (beforeDigest !== restoredDigest) {
    throw new Error("FINAL_CUT_E2E_ROLLBACK_DIGEST_MISMATCH: undo did not restore the pre-edit canonical digest");
  }

  const rawEvidence = {
    passed: true,
    recordedAt: new Date().toISOString(),
    environment: await evidenceEnvironment(),
    editor: editor.identity,
    capabilities: allowlistedCapabilities(editor.capabilities),
    project: {
      id: before.projectId,
      name: before.projectName,
      sequenceId: before.timeline.id,
      occurrenceId,
      mediaId: occurrence.mediaId,
    },
    toolResults,
    normalization: {
      status: execution.status,
      measuredLufs: measurement.integratedLufs,
      measuredTruePeakDb: measurement.truePeakDb,
      proposedGainDb: details.clampedGainDb,
      outputLufs: loudness.observed?.integratedLufs,
      outputTruePeakDb: peak.observed?.truePeakDb,
      toleranceDb,
      maxTruePeakDb,
      beforeRevision: summarizeRevision(before.revision),
      afterRevision: summarizeRevision(after.revision),
      verificationPassed: execution.verification?.passed === true,
    },
    restoration: {
      status: "VERIFIED",
      restored: true,
      restoredRevision: summarizeRevision(restored.revision),
    },
  };
  const evidence = sanitizeDialogueNormalizationEvidence(rawEvidence, rawEvidence.environment);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  if (canUndo && transactionId) {
    try {
      await callJson("edit.undo", { transactionId });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Dialogue-normalization headed E2E failed and compensating undo also failed");
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

function requireDialogueCapabilities(editor) {
  const capabilities = editor.capabilities;
  if (capabilities?.editor?.canonicalTimelineMode !== "canonical-write") {
    throw new Error("CAPABILITY_UNAVAILABLE: headed dialogue normalization requires canonical-write");
  }
  for (const key of ["timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback", "compositeTransactions"]) {
    if (capabilities.editor[key] !== true) throw new Error(`CAPABILITY_UNAVAILABLE: headed dialogue normalization requires ${key}`);
  }
  if (capabilities.analyzers?.audioLoudness !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed dialogue normalization requires audio loudness analysis");
  }
  if (capabilities.editor.semanticOperations?.["set-gain"] !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: headed dialogue normalization requires set-gain");
  }
}

function requirePassedCheck(execution, name) {
  const check = execution.verification?.checks?.find((candidate) => candidate.name === name);
  if (!check?.passed) throw new Error(`FINAL_CUT_E2E_VERIFICATION_FAILED: ${name}`);
  return check;
}

function allowlistedCapabilities(capabilities) {
  return {
    editor: {
      ...pick(capabilities.editor, ["canonicalTimelineMode", "timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback", "compositeTransactions"]),
      semanticOperations: pick(capabilities.editor?.semanticOperations, ["set-gain"]),
    },
    analyzers: pick(capabilities.analyzers, ["audioLoudness"]),
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function summarizeRevision(revision) {
  return { id: revision.id, sequence: revision.sequence, timestamp: revision.timestamp };
}

function optionalNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

async function evidenceEnvironment() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const gitCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) throw new Error("FINAL_CUT_E2E_COMMIT_UNAVAILABLE: git did not return a full commit");
  return {
    framekitVersion: packageJson.version,
    finalCutVersion: (await execFile("osascript", ["-e", 'tell application "Final Cut Pro" to get version'])).stdout.trim(),
    gitCommit,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
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
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
