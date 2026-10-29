import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_DOCS = Object.freeze([
  "docs/README.md",
  "docs/architecture.md",
  "docs/getting-started.md",
  "docs/testing.md",
  "docs/release.md",
]);

export function findNonCanonicalDocs(paths) {
  const allowed = new Set(CANONICAL_DOCS);
  return [...new Set(paths.filter((filePath) => filePath === "docs" || filePath.startsWith("docs/")))]
    .filter((filePath) => !allowed.has(filePath))
    .sort();
}

export function findBrokenMarkdownLinks(files, trackedPaths = files.keys()) {
  const errors = [];
  const tracked = new Set([...trackedPaths, ...files.keys()]);

  for (const [sourcePath, source] of files) {
    for (const link of extractMarkdownLinks(source)) {
      const result = resolveMarkdownLink(sourcePath, link.target, files, tracked);
      if (result.external) continue;
      if (!result.path) {
        errors.push(`${sourcePath}:${link.line} links to missing ${result.description}`);
      } else if (result.fragment && isMarkdownPath(result.path)) {
        const target = files.get(result.path);
        if (target !== undefined && !hasHeading(target, result.fragment)) {
          errors.push(
            `${sourcePath}:${link.line} links to missing heading #${result.fragment} in ${result.path}`,
          );
        }
      }
    }
  }

  return errors.sort();
}

function extractMarkdownLinks(source) {
  const markdown = stripIgnoredMarkdown(source);
  const links = [];
  const expression = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+[^)]*)?\)/g;

  for (const match of markdown.matchAll(expression)) {
    const target = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
    links.push({ target, line: lineNumberAt(markdown, match.index) });
  }

  const definitions = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;
  for (const match of markdown.matchAll(definitions)) {
    const target = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
    links.push({ target, line: lineNumberAt(markdown, match.index) });
  }

  return links;
}

function stripIgnoredMarkdown(source, { preserveInlineCode = false } = {}) {
  const withoutComments = source.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "));
  const lines = withoutComments.split("\n");
  let fence;
  let inInlineCode = false;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        const closing = fenceMatch?.[1];
        if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
        return "";
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        return "";
      }

      let stripped = "";
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "`" && line[index - 1] !== "\\") {
          inInlineCode = !inInlineCode;
          stripped += preserveInlineCode ? line[index] : " ";
        } else {
          stripped += inInlineCode && !preserveInlineCode ? " " : line[index];
        }
      }
      inInlineCode = false;
      return stripped;
    })
    .join("\n");
}

function resolveMarkdownLink(sourcePath, target, files, tracked) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return { external: true };

  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const rawPath = pathEnd === undefined ? target : target.slice(0, pathEnd);
  const rawFragment = hashIndex >= 0 ? target.slice(hashIndex + 1).split("?")[0] : "";

  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(rawPath);
    fragment = decodeURIComponent(rawFragment);
  } catch {
    return { path: undefined, description: `invalid URL-encoded target ${target}` };
  }

  const repoRootPath = decodedPath.startsWith("/");
  if (repoRootPath) decodedPath = decodedPath.slice(1);
  const pathFromSource = decodedPath || (rawPath === "" ? path.posix.basename(sourcePath) : "");
  const normalized = path.posix.normalize(
    repoRootPath ? pathFromSource : path.posix.join(path.posix.dirname(sourcePath), pathFromSource),
  ).replace(/\/+$/, "") || ".";
  const candidates = [normalized];
  if (normalized.endsWith("/")) {
    candidates.push(`${normalized}README.md`, `${normalized}index.md`);
  } else if (!path.posix.extname(normalized)) {
    candidates.push(`${normalized}/README.md`, `${normalized}/index.md`);
  }
  const resolved = candidates.find((candidate) => tracked.has(candidate))
    ?? candidates.find((candidate) => candidate === "." || [...tracked].some((trackedPath) => trackedPath.startsWith(`${candidate}/`)));

  return {
    path: resolved,
    fragment,
    description: `target ${target}`,
  };
}

function hasHeading(markdown, fragment) {
  if (/^L\d+(?:-L?\d+)?$/.test(fragment)) return true;
  const headings = new Set();
  const counts = new Map();

  for (const line of stripIgnoredMarkdown(markdown, { preserveInlineCode: true }).split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = slugifyHeading(heading[1]);
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    headings.add(count === 0 ? slug : `${slug}-${count}`);
  }

  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) headings.add(match[1]);
  return headings.has(fragment);
}

function slugifyHeading(heading) {
  return heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function isMarkdownPath(filePath) {
  return filePath.toLowerCase().endsWith(".md");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const listing = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr || "git ls-files failed");

  const trackedPaths = listing.stdout.split("\0").filter(Boolean);
  const docsErrors = findNonCanonicalDocs(trackedPaths);
  const markdownPaths = trackedPaths.filter(isMarkdownPath);
  const markdownFiles = new Map(
    await Promise.all(markdownPaths.map(async (filePath) => [filePath, await readFile(path.join(root, filePath), "utf8")])),
  );
  const linkErrors = findBrokenMarkdownLinks(markdownFiles, trackedPaths);
  const errors = [
    ...docsErrors.map((filePath) => `non-canonical document under docs/: ${filePath}`),
    ...linkErrors,
  ];

  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log("Documentation allowlist and internal links are valid.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
