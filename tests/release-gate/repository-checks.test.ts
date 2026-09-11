import assert from "node:assert/strict";
import test from "node:test";
import { runRepositoryChecks } from "./repository-checks.js";

test("repository release checks run the frozen install and each required gate independently", async () => {
  const commands: string[] = [];
  const report = await runRepositoryChecks({
    rootDirectory: "/private/framekit",
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
      return { code: 0 };
    },
  });

  assert.deepEqual(commands, [
    "pnpm install --frozen-lockfile",
    "pnpm run build",
    "pnpm run test",
    "pnpm run evaluate",
    "pnpm run check:boundaries",
  ]);
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.map((check) => check.status), [
    "verified",
    "verified",
    "verified",
    "verified",
    "verified",
  ]);
});

test("repository release checks preserve a failed gate without hiding other results", async () => {
  const report = await runRepositoryChecks({
    rootDirectory: "/private/framekit",
    run: async (_command, args) => ({ code: args.includes("build") ? 1 : 0 }),
  });

  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.name === "build")?.status, "failed");
  assert.equal(report.checks.find((check) => check.name === "test")?.status, "verified");
  assert.doesNotMatch(JSON.stringify(report), /\/private\/framekit/);
});
