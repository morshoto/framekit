import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findAvailableReleaseRunner,
  validateReleaseRunnerAvailability,
} from "../../scripts/check-release-runner.mjs";

const requiredLabels = ["self-hosted", "macOS", "framekit-release"];
const checker = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/check-release-runner.mjs");

function runner(overrides: Record<string, unknown> = {}) {
  return {
    id: 236,
    name: "framekit-release-mac",
    status: "online",
    busy: false,
    labels: requiredLabels.map((name) => ({ name })),
    ...overrides,
  };
}

function runChecker(input: unknown) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [checker]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("release runner eligibility accepts an online idle labeled runner", () => {
  const selected = findAvailableReleaseRunner([runner()]);

  assert.equal(selected?.id, 236);
});

test("release runner eligibility ignores busy and offline runners", () => {
  const selected = findAvailableReleaseRunner([
    runner({ id: 1, busy: true }),
    runner({ id: 2, status: "offline" }),
  ]);

  assert.equal(selected, undefined);
});

test("release runner eligibility requires every release label", () => {
  const selected = findAvailableReleaseRunner([
    runner({ labels: requiredLabels.slice(0, -1).map((name) => ({ name })) }),
  ]);

  assert.equal(selected, undefined);
});

test("release runner availability explains how to recover", () => {
  assert.throws(
    () => validateReleaseRunnerAvailability([]),
    /RELEASE_RUNNER_UNAVAILABLE:.*self-hosted, macOS, framekit-release.*Register or start the repository runner/i,
  );
});

test("release runner checker accepts the API response on stdin", async () => {
  const result = await runChecker({ runners: [runner()] });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Release runner available: framekit-release-mac/);
});

test("release runner checker fails closed for an empty API response", async () => {
  const result = await runChecker({ runners: [] });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /RELEASE_RUNNER_UNAVAILABLE/);
});
