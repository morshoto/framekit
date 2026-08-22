import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export function repositoryRoot(cwd = process.cwd()) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

export function installHooks(repoRoot = repositoryRoot()) {
  const root = resolve(repoRoot);
  const hookPath = join(root, ".githooks", "pre-commit");
  if (!existsSync(hookPath)) throw new Error(`Framekit pre-commit hook is missing: ${hookPath}`);
  accessSync(hookPath, constants.X_OK);
  if ((statSync(hookPath).mode & 0o111) === 0) throw new Error(`Framekit pre-commit hook is not executable: ${hookPath}`);
  execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  return { repoRoot: root, hooksPath: ".githooks", hookPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = installHooks();
  process.stdout.write(`Framekit Git hooks installed at ${result.repoRoot}/${result.hooksPath}\n`);
}
