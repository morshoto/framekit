#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FcpxmlDocumentAdapter, classifyFinalCutFcpxmlExperiment } from "@framekit/final-cut";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: FRAMEKIT_FCPXML_PATH=/absolute/path/to/artifact.fcpxml pnpm run test:final-cut-fcpxml-console-experiment\n");
  process.stdout.write("Read-only: no Final Cut import, mutation, or overwrite is attempted.\n");
  process.exit(0);
}

const artifactPath = process.env.FRAMEKIT_FCPXML_PATH;
if (!artifactPath) fail("FCPXML_EXPERIMENT_ARTIFACT_REQUIRED: set FRAMEKIT_FCPXML_PATH");

try {
  const raw = await readFile(artifactPath, "utf8");
  const version = raw.match(/<fcpxml\b[^>]*\bversion="([^"]+)"/)?.[1] ?? "unknown";
  const adapter = new FcpxmlDocumentAdapter(artifactPath);
  const snapshot = await adapter.readProject();
  const observation = {
    artifact: {
      format: "fcpxml",
      version,
      digest: createHash("sha256").update(raw).digest("hex"),
      valid: version === "1.11",
    },
    process: await finalCutProcessState(),
    frontmost: await frontmostState(),
    console: await consoleState(),
    library: await libraryEvidence(),
    log: await logEvidence(),
  };
  const result = classifyFinalCutFcpxmlExperiment(observation);
  process.stdout.write(`${JSON.stringify({
    ...result,
    artifactReadback: {
      projectId: snapshot.projectId,
      projectName: snapshot.projectName,
      sequenceId: snapshot.timeline.id,
      sequenceName: snapshot.timeline.name,
    },
    environment: { platform: process.platform, architecture: process.arch, osVersion: os.version() },
  }, null, 2)}\n`);
  process.exitCode = result.status === "blocked" ? 1 : 0;
} catch (error) {
  fail(`FCPXML_EXPERIMENT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
}

async function finalCutProcessState() {
  try {
    await execFile("pgrep", ["-x", "Final Cut Pro"]);
    return "running";
  } catch {
    return "not-running";
  }
}

async function frontmostState() {
  try {
    const { stdout } = await execFile("osascript", ["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"]);
    const value = stdout.trim();
    return value === "Final Cut Pro" ? "final-cut" : value ? "other" : "unknown";
  } catch {
    return "unknown";
  }
}

async function consoleState() {
  let probe;
  try {
    probe = (await execFile("ioreg", ["-n", "Root", "-d1"])).stdout;
  } catch {
    return { state: "unknown", source: "probe", retryable: true };
  }
  const current = readLockSignal(probe, "IOConsoleLocked");
  const legacy = readLockSignal(probe, "CGSSessionScreenIsLocked");
  if (current && legacy && current !== legacy) return { state: "unknown", source: "conflict", retryable: true };
  const value = current ?? legacy;
  if (!value) return { state: "unknown", source: "none", retryable: true };
  return {
    state: value === "No" ? "unlocked" : value === "Yes" ? "locked" : "unknown",
    source: current ? "IOConsoleLocked" : "CGSSessionScreenIsLocked",
    retryable: value !== "No" && value !== "Yes",
  };
}

function readLockSignal(probe, key) {
  return probe.match(new RegExp(`"${key}"\\s*=\\s*([^,}\\s]+)`))?.[1];
}

async function libraryEvidence() {
  const candidate = process.env.FRAMEKIT_FINAL_CUT_LIBRARY_PATH
    ?? join(os.homedir(), "Movies", "Final Cut Backups.localized");
  try {
    const details = await stat(candidate);
    return { state: details.isDirectory() ? "observed" : "unavailable", evidence: "filesystem" };
  } catch {
    return { state: "not-inspected", evidence: "none" };
  }
}

async function logEvidence() {
  const logPath = process.env.FRAMEKIT_FINAL_CUT_LOG_PATH;
  if (!logPath) return { state: "not-collected", lineCount: 0 };
  try {
    const content = await readFile(logPath, "utf8");
    return { state: "observed", lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length };
  } catch {
    return { state: "unavailable", lineCount: 0 };
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
