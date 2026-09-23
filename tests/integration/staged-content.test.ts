import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanStagedContent, scanText } from "../../scripts/check-staged-content.mjs";

const exec = promisify(execFile);
const scanner = fileURLToPath(new URL("../../scripts/check-staged-content.mjs", import.meta.url));

test("staged-content sanitization permits explanatory prose", () => {
  const findings = scanText([
    "No API key is required for this operation.",
    "The secret to success is practice.",
    "Use an allowlisted evidence summary.",
  ].join("\n"), "README.md");

  assert.deepEqual(findings, []);
});

test("staged-content sanitization reports redacted findings", () => {
  const userPath = ["/", "Users", "/", "alice", "/", "footage.mov"].join("");
  const credential = ["API", "_KEY", "=", "do-not-commit"].join("");
  const diagnostic = ["raw", " ", "crash", " ", "dump"].join("");
  const findings = scanText([userPath, credential, diagnostic].join("\n"), "evidence.txt");

  assert.deepEqual(findings.map(({ category, line }) => ({ category, line })), [
    { category: "user-specific path", line: 1 },
    { category: "credential", line: 2 },
    { category: "diagnostic dump", line: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /alice|do-not-commit/);
});

test("staged-content sanitization inspects the index and staged filenames", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-staged-content-"));
  try {
    await runGit(directory, ["init", "--quiet"]);
    const userPath = ["/", "home", "/", "alice", "/", "footage.mov"].join("");
    const credential = ["ACCESS", "_TOKEN", ":", "do-not-commit"].join("");
    await writeFile(join(directory, "evidence.txt"), `${userPath}\n${credential}\n`, "utf8");
    await writeFile(join(directory, "private-footage.mov"), Buffer.from([0, 1, 2]));
    await runGit(directory, ["add", "--", "evidence.txt", "private-footage.mov"]);

    const findings = scanStagedContent(directory);

    assert.ok(findings.some(({ path, category }) => path === "evidence.txt" && category === "user-specific path"));
    assert.ok(findings.some(({ path, category }) => path === "evidence.txt" && category === "credential"));
    assert.ok(findings.some(({ path, category }) => path === "private-footage.mov" && category === "private media file"));
    assert.ok(findings.some(({ path, category }) => path === "private-footage.mov" && category === "binary staged content"));
    assert.doesNotMatch(JSON.stringify(findings), /alice|do-not-commit/);

    await assert.rejects(
      exec("node", [scanner], { cwd: directory }),
      (error: { stdout?: string; stderr?: string }) => {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.match(output, /staged-content check failed/);
        assert.doesNotMatch(output, /alice|do-not-commit/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged-content sanitization ignores unstaged edits", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-staged-content-"));
  try {
    await runGit(directory, ["init", "--quiet"]);
    const file = join(directory, "evidence.txt");
    await writeFile(file, "safe content\n", "utf8");
    await runGit(directory, ["add", "--", "evidence.txt"]);
    const userPath = ["/", "Users", "/", "alice", "/", "footage.mov"].join("");
    await writeFile(file, `${userPath}\n`, "utf8");

    assert.deepEqual(scanStagedContent(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runGit(directory: string, args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return exec("git", args, { cwd: directory, env });
}
