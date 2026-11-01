import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCurrentPullRequestPolicy } from './verify-policy.mjs';

const POLICY_CHECK = 'CodeQL policy gate';
const CODEQL_WORKFLOW_PATH = '.github/workflows/codeql.yml';

export function pullRequestsForCodeQLRun(workflowRun) {
  if (workflowRun?.event !== 'pull_request' || workflowRun.path !== CODEQL_WORKFLOW_PATH ||
      !Array.isArray(workflowRun.pull_requests)) return [];
  return workflowRun.pull_requests
    .filter((pullRequest) => Number.isInteger(pullRequest.number) && pullRequest.number > 0 &&
      pullRequest.head?.sha === workflowRun.head_sha)
    .map((pullRequest) => ({ number: pullRequest.number, headSha: pullRequest.head.sha }));
}

async function request(apiUrl, repository, path, token, method = 'GET', body) {
  const response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return response.json();
}

function checkOutput(conclusion, reasons) {
  const summary = conclusion === 'success'
    ? 'The current JavaScript/TypeScript CodeQL analysis passed the pull request policy.'
    : reasons.map((reason) => `- ${reason}`).join('\n').slice(0, 60_000) || 'CodeQL analysis or policy evidence is unavailable.';
  return { title: 'JavaScript/TypeScript security policy', summary };
}

async function evaluatePullRequest({ apiUrl, repository, token, workflowRun, pullRequestNumber, expectedHeadSha }) {
  const pullRequest = await request(apiUrl, repository, `/pulls/${pullRequestNumber}`, token);
  if (pullRequest.state !== 'open' || pullRequest.draft || pullRequest.base?.ref !== 'main' ||
      pullRequest.head?.sha !== expectedHeadSha || workflowRun.head_sha !== expectedHeadSha) {
    console.log(`Skipping stale or draft CodeQL run for pull request #${pullRequestNumber}.`);
    return;
  }

  const check = await request(apiUrl, repository, '/check-runs', token, 'POST', {
    name: POLICY_CHECK,
    head_sha: expectedHeadSha,
    external_id: `codeql-policy:${workflowRun.id}:${workflowRun.run_attempt}:${pullRequestNumber}`,
    details_url: workflowRun.html_url,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    output: {
      title: 'JavaScript/TypeScript security policy',
      summary: 'Evaluating the current pull request analysis and alert evidence.',
    },
  });

  let conclusion = 'failure';
  let reasons = [];
  try {
    if (workflowRun.conclusion !== 'success') {
      reasons = [`The CodeQL workflow completed with ${workflowRun.conclusion ?? 'an unknown result'}.`];
    } else {
      const result = await verifyCurrentPullRequestPolicy({
        repository,
        token,
        pullRequestNumber,
        expectedHeadSha,
        expectedBaseSha: pullRequest.base.sha,
        expectedMergeSha: pullRequest.merge_commit_sha,
      });
      conclusion = result.pass ? 'success' : 'failure';
      reasons = result.reasons;
    }
  } catch (error) {
    reasons = [error instanceof Error ? error.message : 'CodeQL policy evaluation failed.'];
  }

  await request(apiUrl, repository, `/check-runs/${check.id}`, token, 'PATCH', {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: checkOutput(conclusion, reasons),
  });
  console.log(`Published ${POLICY_CHECK} as ${conclusion} for pull request #${pullRequestNumber}.`);
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, GITHUB_API_URL: apiUrl = 'https://api.github.com',
    GITHUB_EVENT_PATH: eventPath } = process.env;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository) || !token || !eventPath) {
    throw new Error('Missing workflow run identity or GitHub credentials');
  }
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const workflowRun = event.workflow_run;
  if (!workflowRun || !Number.isInteger(workflowRun.id) || !Number.isInteger(workflowRun.run_attempt)) {
    throw new Error('The CodeQL workflow run identity is invalid');
  }
  for (const pullRequest of pullRequestsForCodeQLRun(workflowRun)) {
    await evaluatePullRequest({
      apiUrl, repository, token, workflowRun,
      pullRequestNumber: pullRequest.number,
      expectedHeadSha: pullRequest.headSha,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
