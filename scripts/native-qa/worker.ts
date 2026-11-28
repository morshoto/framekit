import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertQaHeadlessProfile, inspectRun } from "./run-store.js";
import { publishQaRecord } from "./atomic-record.js";
import { verifyQaArtifact } from "./artifact-evidence.js";
import { verifyQaPublisherFixture } from "./publisher-fixture-evidence.js";
import { verifyQaPublisherSources } from "./publisher-source-evidence.js";
import { runHeadlessQaChecks } from "./headless-checks.js";
import type { HeadlessEvidence } from "./supervisor.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const [root, qaRunId] = process.argv.slice(2);
if (!root || !qaRunId || process.argv.length !== 4) throw new Error("QA_WORKER_ARGUMENTS_INVALID");
let inputText = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  inputText += chunk;
  if (inputText.length > 8192) throw new Error("QA_WORKER_INPUT_INVALID");
}
const input: unknown = JSON.parse(inputText);
if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("QA_WORKER_INPUT_INVALID");
const item = input as Record<string, unknown>;
if (Object.keys(item).some(key => key !== "artifactPath" && key !== "publisherFixture") || (item.publisherFixture !== undefined && item.publisherFixture !== true)
  || (item.publisherFixture === true && item.artifactPath === undefined)
  || (item.artifactPath !== undefined && (typeof item.artifactPath !== "string" || !isAbsolute(item.artifactPath) || item.artifactPath.length > 4096 || item.artifactPath.includes("\0")))) throw new Error("QA_WORKER_INPUT_INVALID");
const artifactPath = item.artifactPath as string | undefined;
const run = await inspectRun(root, qaRunId);
assertQaHeadlessProfile(run, item.publisherFixture === true ? "publisher-e2e-v1" : "generic");
const directory = join(root, qaRunId);
const started = Date.now();
try {
  await publishQaRecord(join(directory, "headless-started"), `${JSON.stringify({ schemaVersion: 1, startedAt: new Date(started).toISOString() })}\n`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") process.exit(0);
  throw error;
}
const candidateMatches = async () => {
  const options = { cwd: checkout, timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnvironment };
  const [head, tree, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], options),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], options),
    execFileAsync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], options),
  ]);
  return head.stdout.trim() === run.manifest.candidateCommit && tree.stdout.trim() === run.manifest.candidateTree && status.stdout.trim() === "";
};
const result = await runHeadlessQaChecks({
  candidateMatches,
  ...(artifactPath === undefined ? {} : { verifyArtifact: async () => {
    await verifyQaArtifact(root, qaRunId, artifactPath);
    if (item.publisherFixture === true) {
      await verifyQaPublisherFixture(root, qaRunId, artifactPath);
      await verifyQaPublisherSources(root, qaRunId, artifactPath);
    }
  } }),
  ...(item.publisherFixture === true && artifactPath !== undefined ? { verifySourcesAfter: async () => { await verifyQaPublisherSources(root, qaRunId, artifactPath); } } : {}),
  runRenderContract: async () => {
    await execFileAsync(process.execPath, ["--import", "tsx", "--test", "tests/runtime/editing/render-contract.test.ts"], {
      cwd: checkout, timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, FRAMEKIT_EDITOR: "memory", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1" },
    });
  },
});
const evidence: HeadlessEvidence = {
  schemaVersion: 1, tier: "headless", result,
  startedAt: new Date(started).toISOString(), finishedAt: new Date(Math.max(started, Date.now())).toISOString(),
};
await publishQaRecord(join(directory, "headless-result.json"), `${JSON.stringify(evidence)}\n`);
