import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scan when native compiler inputs or CodeQL extraction configuration change.
export function affectsSwift(paths) {
  return paths.some((path) =>
    path.endsWith('.swift') ||
    /\.(?:h|m|mm|modulemap)$/.test(path) ||
    path.startsWith('adapters/final-cut/swift-bridge/') ||
    path.startsWith('.github/codeql/') ||
    path === '.github/workflows/codeql.yml' ||
    path === '.github/workflows/swift.yml' ||
    path === 'nix/check-xcode.sh',
  );
}

export function selectScans({ eventName, draft = false, paths = null }) {
  // PRs retain JavaScript/TypeScript CodeQL, but never launch the slow Swift
  // extractor. The independent Swift CI type-check still gates every PR.
  if (eventName === 'pull_request') {
    return { runCodeQL: !draft, swift: false };
  }
  // On main, scan Swift after a relevant push; scheduled/manual runs scan all.
  const forceFullScan = eventName !== 'push';
  // Unknown or empty push diffs run Swift rather than silently skipping security.
  return {
    runCodeQL: true,
    swift: forceFullScan || !paths?.length || affectsSwift(paths),
  };
}

async function getJSON(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub diff request failed (${response.status})`);
  return response.json();
}

export async function getChangedPaths({ repository, before, sha, token }) {
  if (!/^[a-f0-9]{40}$/.test(before ?? '') || /^0{40}$/.test(before) ||
      !/^[a-f0-9]{40}$/.test(sha ?? '')) return null;
  const endpoint = `https://api.github.com/repos/${repository}`;
  const comparison = await getJSON(`${endpoint}/compare/${before}...${sha}`, token);
  // The Compare API returns at most 300 files. Never use a truncated diff to skip.
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return null;
  return comparison.files.map(({ filename }) => filename);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const draft = process.env.PR_DRAFT === 'true';
  let paths = null;
  if (eventName === 'push') {
    try {
      paths = await getChangedPaths({
        repository: process.env.GITHUB_REPOSITORY,
        before: process.env.PUSH_BEFORE,
        sha: process.env.GITHUB_SHA,
        token: process.env.GITHUB_TOKEN,
      });
    } catch (error) {
      console.warn(`Change detection unavailable: ${error.message}; running Swift CodeQL.`);
    }
  }
  const selection = selectScans({ eventName, draft, paths });
  const summary = `run_codeql=${selection.runCodeQL}\nswift=${selection.swift}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, summary);
  console.log(`CodeQL selection for ${eventName}: ${summary.trim().replaceAll('\n', ', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
