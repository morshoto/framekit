import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectRun } from "./run-store.js";
import type { HeadlessEvidence, HeadlessResult } from "./supervisor.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const [root, qaRunId] = process.argv.slice(2);
if (!root || !qaRunId || process.argv.length !== 4) throw new Error("QA_WORKER_ARGUMENTS_INVALID");
const run = await inspectRun(root, qaRunId);
const directory = join(root, qaRunId);
let lock;
try { lock = await open(join(directory, "headless-started"), "wx", 0o600); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") process.exit(0);
  throw error;
}
try { await lock.writeFile("started\n"); await lock.sync(); }
finally { await lock.close(); }
const directoryHandle = await open(directory, "r");
try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
const started = Date.now();
let result: HeadlessResult = "preflight-error";
const candidateMatches = async () => {
  const options = { cwd: checkout, timeout: 10000, maxBuffer: 1024 * 1024 };
  const [head, tree, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], options),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], options),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], options),
  ]);
  return head.stdout.trim() === run.manifest.candidateCommit && tree.stdout.trim() === run.manifest.candidateTree && status.stdout.trim() === "";
};
try {
  if (!await candidateMatches()) result = "candidate-mismatch";
  else {
    try {
      await execFileAsync(process.execPath, ["--import", "tsx", "--test", "tests/runtime/editing/render-contract.test.ts"], {
        cwd: checkout, timeout: 120000, maxBuffer: 1024 * 1024,
        env: { ...process.env, FRAMEKIT_EDITOR: "memory", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1" },
      });
      result = "render-contract-passed";
    } catch { result = "render-contract-failed"; }
    if (!await candidateMatches()) result = "candidate-changed";
  }
} catch { result = "preflight-error"; }
const evidence: HeadlessEvidence = {
  schemaVersion: 1, tier: "headless", result,
  startedAt: new Date(started).toISOString(), finishedAt: new Date(Math.max(started, Date.now())).toISOString(),
};
const file = await open(join(directory, "headless-result.json"), "wx", 0o600);
try { await file.writeFile(`${JSON.stringify(evidence)}\n`); await file.sync(); }
finally { await file.close(); }
const resultDirectory = await open(directory, "r");
try { await resultDirectory.sync(); } finally { await resultDirectory.close(); }
