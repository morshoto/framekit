#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  FcpxmlDocumentAdapter,
  FinalCutProjectPublisher,
  classifyFinalCutFcpxmlExperiment,
  createFinalCutLiveAdapter,
} from "@framekit/final-cut";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: FRAMEKIT_FCPXML_PATH=/absolute/path/to/artifact.fcpxml pnpm run test:final-cut-fcpxml-console-experiment [--execute]\n");
  process.stdout.write("Read-only by default. --execute requires FRAMEKIT_FINAL_CUT_EXPERIMENT_CONFIRM=1 and a disposable library path.\n");
  process.exit(0);
}

const artifactPath = process.env.FRAMEKIT_FCPXML_PATH;
if (!artifactPath) {
  fail("FCPXML_EXPERIMENT_ARTIFACT_REQUIRED: set FRAMEKIT_FCPXML_PATH");
  process.exit(1);
}
const executeImport = process.argv.includes("--execute");

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
  let materialization;
  if (executeImport) {
    if (process.env.FRAMEKIT_FINAL_CUT_EXPERIMENT_CONFIRM !== "1") {
      throw new Error("FCPXML_EXPERIMENT_CONFIRMATION_REQUIRED: set FRAMEKIT_FINAL_CUT_EXPERIMENT_CONFIRM=1 for disposable import");
    }
    if (!process.env.FRAMEKIT_FINAL_CUT_LIBRARY_PATH) {
      throw new Error("FCPXML_EXPERIMENT_DISPOSABLE_LIBRARY_REQUIRED: set FRAMEKIT_FINAL_CUT_LIBRARY_PATH to a disposable library");
    }
    if (observation.console.state === "locked" || observation.console.state === "unknown") {
      materialization = {
        status: "blocked",
        attempted: false,
        reason: result.blockers[0]?.code ?? "FINAL_CUT_NATIVE_CONSOLE_LOCKED",
      };
    } else if (observation.process !== "running") {
      materialization = {
        status: "blocked",
        attempted: false,
        reason: "FINAL_CUT_NOT_RUNNING",
      };
    } else {
      try {
        materialization = await importAndReadback(artifactPath, raw, observation);
      } catch (error) {
        materialization = {
          status: "failed",
          attempted: true,
          error: safeError(error, artifactPath),
        };
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    ...result,
    artifactReadback: {
      projectId: snapshot.projectId,
      projectName: snapshot.projectName,
      sequenceId: snapshot.timeline.id,
      sequenceName: snapshot.timeline.name,
    },
    ...(materialization ? { materialization } : {}),
    environment: { platform: process.platform, architecture: process.arch, osVersion: os.version() },
  }, null, 2)}\n`);
  process.exitCode = result.status === "blocked" || materialization?.status === "blocked" || materialization?.status === "failed" ? 1 : 0;
} catch (error) {
  fail(`FCPXML_EXPERIMENT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
}

async function importAndReadback(artifactPath, raw, observation) {
  const live = createFinalCutLiveAdapter();
  const before = await live.readLiveState();
  if (!before.project?.id || !before.sequence?.id) {
    throw new Error("FINAL_CUT_EXPERIMENT_TARGET_REQUIRED: live project and sequence identities are required before import");
  }
  const publisher = new FinalCutProjectPublisher({
    enabled: true,
    sourcePath: artifactPath,
    liveState: () => live.readLiveState(),
  });
  const published = await publisher.publishNewProject({
    sourceTransactionId: `experiment-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`,
    artifactPath,
    artifactDigest: observation.artifact.digest,
    confirm: true,
  });
  const after = await live.readLiveState();
  return {
    status: "verified",
    attempted: true,
    verified: published.verified,
    before: summarizeLiveIdentity(before),
    after: summarizeLiveIdentity(after),
    createdTarget: published.createdTarget,
  };
}

function summarizeLiveIdentity(state) {
  return {
    project: state.project ? { id: state.project.id, name: state.project.name } : undefined,
    sequence: state.sequence ? { id: state.sequence.id, name: state.sequence.name } : undefined,
    revision: state.revision ? { id: state.revision.id, sequence: state.revision.sequence } : undefined,
  };
}

function safeError(error, artifactPath) {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(artifactPath, "<artifact>");
  const separator = message.indexOf(":");
  return {
    code: separator > 0 ? message.slice(0, separator) : "FINAL_CUT_EXPERIMENT_IMPORT_FAILED",
    message,
  };
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
