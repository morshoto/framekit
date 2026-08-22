import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const nativePathPrefixes = [
  "adapters/final-cut/swift-bridge/",
  "nix/check-xcode.sh",
  "nix/xcode-version.json",
];

export function isNativePath(path) {
  return nativePathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

export function hasNativeChanges(paths) {
  return paths.some(isNativePath);
}

export function stagedPaths(cwd = process.cwd()) {
  const output = execFileSync("git", ["-C", cwd, "diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"], { encoding: "utf8" });
  return output.split("\n").map((path) => path.trim()).filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(hasNativeChanges(stagedPaths()) ? "true\n" : "false\n");
}
