import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISSUE_TITLE = '[security-ci] Post-push checks failing';
const REPORTING_ACTOR = 'github-actions[bot]';

function marker(runId, attempt) {
  return `<!-- security-ci-run:${runId}:${attempt} -->`;
}

export function hasReportedAttempt(comments, runId, attempt) {
  return comments.some((comment) => comment.user?.login === REPORTING_ACTOR &&
    comment.body?.includes(marker(runId, attempt)));
}

export function isReportingIssue(issue) {
  return !issue.pull_request && issue.title === ISSUE_TITLE && issue.user?.login === REPORTING_ACTOR;
}

export function failureReport({ sha, runId, attempt, serverUrl, repository, codeql, deep, consumer }) {
  return [
    marker(runId, attempt),
    'Post-push security or deep validation did not complete successfully on main.',
    '',
    `- Commit: \`${sha}\``,
    `- Run: ${serverUrl}/${repository}/actions/runs/${runId}`,
    `- CodeQL: ${codeql}`,
    `- Full validation: ${deep}`,
    `- Consumer runtime: ${consumer}`,
    '',
    'Security findings are available in GitHub code scanning; this report covers workflow execution.',
  ].join('\n');
}

async function request(url, token, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub issue API request failed (${response.status})`);
  return response.json();
}

async function pages(url, token) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const next = new URL(url);
    next.searchParams.set('per_page', '100');
    next.searchParams.set('page', String(page));
    const batch = await request(next, token);
    if (!Array.isArray(batch)) throw new Error('GitHub issue API returned a non-list response');
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error('GitHub issue API pagination exceeded the safety limit');
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, GITHUB_SHA: sha,
    GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SERVER_URL: serverUrl,
    CODEQL_RESULT: codeql, DEEP_RESULT: deep, CONSUMER_RESULT: consumer } = process.env;
  if (!repository || !token || !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^\d+$/.test(runId ?? '') ||
      !/^\d+$/.test(attempt ?? '') || !serverUrl || ![codeql, deep, consumer].every((item) => ['success', 'failure', 'cancelled', 'skipped'].includes(item))) {
    throw new Error('Security failure report identity or job outcomes are missing');
  }
  if (![codeql, deep, consumer].some((item) => item === 'failure' || item === 'cancelled')) {
    throw new Error('Refusing to create a security failure report without a failed or cancelled job');
  }
  const endpoint = `https://api.github.com/repos/${repository}`;
  const issues = (await pages(`${endpoint}/issues?state=open`, token)).filter(isReportingIssue);
  if (issues.length > 1) throw new Error('Multiple open security failure issues require manual reconciliation');
  const body = failureReport({ sha, runId, attempt, serverUrl, repository, codeql, deep, consumer });
  if (issues.length === 0) {
    const issue = await request(`${endpoint}/issues`, token, { title: ISSUE_TITLE, body });
    console.log(`Created security failure issue #${issue.number}.`);
    return;
  }
  const issue = issues[0];
  const comments = await pages(`${endpoint}/issues/${issue.number}/comments`, token);
  if (hasReportedAttempt([issue, ...comments], runId, attempt)) {
    console.log(`Security run ${runId} attempt ${attempt} was already reported.`);
    return;
  }
  await request(`${endpoint}/issues/${issue.number}/comments`, token, { body });
  console.log(`Updated security failure issue #${issue.number}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
