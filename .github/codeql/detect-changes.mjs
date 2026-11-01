import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ready pull requests run JS/TS; full security events include Swift.
export function selectScans({ eventName, draft = false }) {
  const pullRequest = eventName === 'pull_request';
  return { runCodeQL: !pullRequest || !draft, swift: !pullRequest };
}

async function main() {
  const selection = selectScans({
    eventName: process.env.GITHUB_EVENT_NAME,
    draft: process.env.PR_DRAFT === 'true',
  });
  const summary = `run_codeql=${selection.runCodeQL}\nswift=${selection.swift}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, summary);
  console.log(`CodeQL selection: ${summary.trim().replaceAll('\n', ', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
