import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const maxScannableBytes = 5 * 1024 * 1024;

const privatePathRoots = ["Users", "home", "private", "var/folders"].join("|");
const sensitiveCredentialNames = ["api[-_ ]?key", "access[-_ ]?token", "password", "secret", "authorization"];
const sensitiveCredentialPattern = `(?:${sensitiveCredentialNames.join("|")})`;
const sensitiveEnvironmentPattern = "(?:API[-_ ]?KEY|ACCESS[-_ ]?TOKEN|PASSWORD|SECRET|AUTHORIZATION)";

const contentRules = [
  {
    category: "user-specific path",
    pattern: new RegExp(
      `(?:^|[\\s"'\`(=])(?:file://)?/(?:${privatePathRoots})(?:[/\\\\])\\S+`,
      "i",
    ),
  },
  {
    category: "user-specific path",
    pattern: new RegExp(
      `(?:^|[\\s"'\`(=])[A-Za-z]:[/\\\\](?:${privatePathRoots})(?:[/\\\\])\\S+`,
      "i",
    ),
  },
  {
    category: "credential",
    pattern: new RegExp(`${sensitiveCredentialPattern}\\s*[:=]\\s*[^\\s"'\`]+`, "i"),
  },
  {
    category: "credential",
    pattern: new RegExp(
      `(?:^|\\b(?:export|set)\\s+|--env\\s+|--?[A-Za-z0-9_-]+[=\\s]+)${sensitiveEnvironmentPattern}(?:=|\\s+)\\S+`,
      "i",
    ),
  },
  {
    category: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  },
  {
    category: "credential",
    pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/,
  },
  {
    category: "credential",
    pattern: /\b(?:ghp_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{16}|sk-)[A-Za-z0-9._~-]{8,}/,
  },
  {
    category: "diagnostic dump",
    pattern: new RegExp(
      "\\b(?:crash\\s+dump|stack\\s+trace|panic\\s+trace|raw\\s+diagnostics?)\\b",
      "i",
    ),
  },
];

const pathRules = [
  {
    category: "credential file",
    pattern: new RegExp(
      "(?:^|/)(?:(?:credentials?|secrets?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|\\.env(?:\\.(?!example$|sample$|template$).*)?|[^/]+\\.(?:pem|key|p12|pfx|mobileprovision))$",
      "i",
    ),
  },
  {
    category: "private media file",
    pattern: /\.(?:mov|mp4|m4v|avi|mkv|webm|mxf|wav|mp3|aac|flac|aiff|caf|m4a|fcpbundle)$/i,
  },
  {
    category: "diagnostic dump file",
    pattern: /(?:^|\/)(?:crash|panic)[^/]*\.(?:log|ips|dmp|core|crash)$/i,
  },
];

export function scanText(text, filePath = "<text>") {
  const lines = String(text).split(/\r?\n/).map((line, index) => ({ text: line, line: index + 1 }));
  return scanLines(lines, filePath);
}

export function scanStagedContent(cwd = process.cwd()) {
  const findings = [];
  for (const filePath of stagedPaths(cwd)) {
    findings.push(...scanPath(filePath));

    const blob = stagedBlob(cwd, filePath);
    if (!blob || blob.mode === "160000") continue;

    const size = Number(runGit(cwd, ["cat-file", "-s", blob.oid], { encoding: "utf8" }).trim());
    if (!Number.isSafeInteger(size) || size > maxScannableBytes) {
      findings.push({ path: filePath, category: "staged content too large to scan" });
      continue;
    }

    const content = runGit(cwd, ["cat-file", "blob", blob.oid], { maxBuffer: maxScannableBytes + 1 });
    if (content.includes(0)) {
      findings.push({ path: filePath, category: "binary staged content" });
      continue;
    }

    findings.push(...scanLines(stagedAdditions(cwd, filePath), filePath));
  }
  return findings;
}

export function stagedPaths(cwd = process.cwd()) {
  const output = runGit(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB", "--"]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedBlob(cwd, filePath) {
  const output = runGit(cwd, ["ls-files", "--stage", "-z", "--", filePath]).toString("utf8");
  const record = output.split("\0").find(Boolean);
  const match = record?.match(/^(\d{6}) ([0-9a-f]{40}) (\d)\t/);
  return match ? { mode: match[1], oid: match[2], stage: Number(match[3]) } : undefined;
}

function stagedAdditions(cwd, filePath) {
  const diff = runGit(cwd, ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=0", "--", filePath]).toString("utf8");
  const lines = [];
  let nextLine;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || nextLine === undefined) continue;
    if (line.startsWith("+")) {
      lines.push({ text: line.slice(1), line: nextLine });
      nextLine += 1;
    } else if (line.startsWith("-")) {
      continue;
    } else if (!line.startsWith("\\")) {
      nextLine += 1;
    }
  }
  return lines;
}

function scanPath(filePath) {
  return pathRules
    .filter(({ pattern }) => pattern.test(filePath))
    .map(({ category }) => ({ path: filePath, category }));
}

function scanLines(lines, filePath) {
  const findings = [];
  for (const { text, line } of lines) {
    const categories = new Set();
    for (const { category, pattern } of contentRules) {
      if (pattern.test(text) && !categories.has(category)) {
        categories.add(category);
        findings.push({ path: filePath, line, category });
      }
    }
  }
  return findings;
}

function runGit(cwd, args, options = {}) {
  const { env, ...childOptions } = options;
  return execFileSync("git", args, {
    ...childOptions,
    cwd,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_WORK_TREE: undefined,
      ...env,
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanStagedContent();
  if (findings.length === 0) process.exit(0);

  process.stderr.write("Framekit staged-content check failed; sanitize the staged commit payload before committing.\n");
  for (const finding of findings) {
    const location = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
    process.stderr.write(`- ${location}: ${finding.category}\n`);
  }
  process.stderr.write("No matched content is printed. Remove or sanitize the affected content, then stage it again.\n");
  process.exitCode = 1;
}
