import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectsSwift, getChangedPaths } from './detect-changes.mjs';

const JAVASCRIPT_CATEGORY = '/language:javascript-typescript';
const SWIFT_CATEGORY = '/language:swift';
const CHECK_NAME = 'CodeQL policy gate';

function isBlockingAlert(alert) {
  if (alert.state !== 'open') return false;
  const severity = alert.rule?.severity?.toLowerCase();
  const securitySeverity = alert.rule?.security_severity_level?.toLowerCase();
  return severity === 'error' || ['high', 'critical'].includes(securitySeverity);
}

function newestAnalysis(analyses, category, mergeSha, pullRef) {
  return analyses
    .filter((analysis) =>
      analysis.ref === pullRef &&
      analysis.commit_sha === mergeSha &&
      analysis.category === category &&
      analysis.tool?.name === 'CodeQL',
    )
    .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0];
}

export function evaluateCodeQLPolicy({
  workflowHeadSha,
  pullRequestHeadSha,
  pullRequestNumber,
  mergeSha,
  swiftRequired,
  analyses,
  pullRequestAlerts,
  baseAlerts,
}) {
  const reasons = [];
  if (!pullRequestHeadSha || workflowHeadSha !== pullRequestHeadSha) {
    reasons.push('The CodeQL workflow run does not match the current pull request head.');
  }
  if (!mergeSha) reasons.push('GitHub has not produced a current pull request merge commit.');
  if (!Array.isArray(analyses)) reasons.push('CodeQL analysis evidence is unavailable.');
  if (!Array.isArray(pullRequestAlerts) || !Array.isArray(baseAlerts)) {
    reasons.push('CodeQL alert evidence is unavailable.');
  }
  if (reasons.length > 0) return { pass: false, reasons };

  const expectedRef = `refs/pull/${pullRequestNumber}/merge`;
  if (!Number.isInteger(Number(pullRequestNumber)) || Number(pullRequestNumber) < 1) {
    reasons.push('The pull request number is missing or invalid.');
  }
  const requiredCategories = [JAVASCRIPT_CATEGORY];
  if (swiftRequired) requiredCategories.push(SWIFT_CATEGORY);

  for (const category of requiredCategories) {
    const analysis = newestAnalysis(analyses, category, mergeSha, expectedRef || pullRef);
    if (!analysis) {
      reasons.push(`Missing current ${category} CodeQL analysis.`);
      continue;
    }
    if (analysis.error) {
      reasons.push(`${category} CodeQL analysis failed: ${analysis.error}`);
    }
    if (!Number.isInteger(analysis.rules_count) || analysis.rules_count <= 0) {
      reasons.push(`${category} CodeQL analysis did not load any rules.`);
    }
  }

  const baselineAlertNumbers = new Set(
    baseAlerts.filter((alert) => alert.state === 'open').map((alert) => String(alert.number)),
  );
  const newBlockingAlerts = pullRequestAlerts.filter((alert) =>
    !baselineAlertNumbers.has(String(alert.number)) && isBlockingAlert(alert),
  );
  if (newBlockingAlerts.length > 0) {
    reasons.push(
      `Found ${newBlockingAlerts.length} new CodeQL alert(s) at the blocking thresholds.`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}

function apiURL(repository, path) {
  return `https://api.github.com/repos/${repository}${path}`;
}

async function getJSON(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return response.json();
}

async function getPages(repository, path, token) {
  const values = [];
  for (let page = 1; page <= 100; page++) {
    const url = new URL(apiURL(repository, path));
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const entries = await getJSON(url, token);
    if (!Array.isArray(entries)) throw new Error('GitHub API returned a non-list response');
    values.push(...entries);
    if (entries.length < 100) return values;
  }
  throw new Error('GitHub API pagination exceeded the safety limit');
}

function checkOutput(result, swiftRequired) {
  const swift = swiftRequired ? 'Swift analysis required.' : 'Swift sources unchanged; Swift analysis skipped.';
  return {
    title: result.pass ? 'CodeQL policy passed' : 'CodeQL policy failed',
    summary: [swift, ...result.reasons].join('\n'),
  };
}

async function createCheck(repository, token, { headSha, runId, detailsUrl, result, swiftRequired }) {
  const body = {
    name: CHECK_NAME,
    head_sha: headSha,
    external_id: `codeql-policy-${runId}`,
    status: 'completed',
    conclusion: result.pass ? 'success' : 'failure',
    completed_at: new Date().toISOString(),
    details_url: detailsUrl,
    output: checkOutput(result, swiftRequired),
  };
  const response = await fetch(apiURL(repository, '/check-runs'), {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Unable to publish ${CHECK_NAME} (${response.status})`);
}

async function findPullRequest(repository, run, token) {
  const matches = (run.pull_requests ?? []).filter((pull) => pull?.number);
  if (matches.length === 1) return getJSON(apiURL(repository, `/pulls/${matches[0].number}`), token);
  if (matches.length > 1) throw new Error('CodeQL run is associated with multiple pull requests');
  if (!run.head_branch) return null;

  const [owner] = repository.split('/');
  const url = new URL(apiURL(repository, '/pulls'));
  url.searchParams.set('state', 'open');
  url.searchParams.set('head', `${owner}:${run.head_branch}`);
  url.searchParams.set('base', 'main');
  const pulls = await getJSON(url, token);
  if (!Array.isArray(pulls)) throw new Error('GitHub returned invalid pull request data');
  if (pulls.length === 0) return null;
  if (pulls.length !== 1) throw new Error('Unable to identify one pull request for the CodeQL run');
  return pulls[0];
}

async function getRun(repository, token, runId) {
  return getJSON(apiURL(repository, `/actions/runs/${runId}`), token);
}

async function inspectPullRequest(repository, token, pullRequest, workflowHeadSha, workflowConclusion) {
  const pullRequestNumber = pullRequest.number;
  const pullRequestHeadSha = pullRequest.head?.sha;
  const mergeSha = pullRequest.merge_commit_sha;
  const pullRef = `refs/pull/${pullRequestNumber}/merge`;

  if (workflowConclusion !== 'success') {
    return {
      swiftRequired: true,
      result: { pass: false, reasons: [`The CodeQL workflow concluded ${workflowConclusion ?? 'without success'}.`] },
    };
  }

  let changedPaths = null;
  try {
    changedPaths = await getChangedPaths({
      eventName: 'pull_request',
      repository,
      prNumber: pullRequestNumber,
      token,
    });
  } catch (error) {
    console.warn(`Changed-path lookup failed: ${error.message}`);
  }
  const swiftRequired = changedPaths === null || affectsSwift(changedPaths);

  const analyses = await getPages(
    repository,
    `/code-scanning/analyses?ref=${encodeURIComponent(pullRef)}&tool_name=CodeQL`,
    token,
  );
  const pullRequestAlerts = await getPages(
    repository,
    `/code-scanning/alerts?ref=${encodeURIComponent(pullRef)}&tool_name=CodeQL&state=open`,
    token,
  );
  const baseAlerts = await getPages(
    repository,
    '/code-scanning/alerts?ref=refs%2Fheads%2Fmain&tool_name=CodeQL&state=open',
    token,
  );
  const result = evaluateCodeQLPolicy({
    workflowHeadSha,
    pullRequestHeadSha,
    pullRequestNumber,
    mergeSha,
    swiftRequired,
    analyses,
    pullRequestAlerts,
    baseAlerts,
  });
  return { swiftRequired, result };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

  const eventName = process.env.GITHUB_EVENT_NAME;
  const dispatchNumber = process.env.DISPATCH_PR_NUMBER;
  let run;
  let pullRequest;
  if (eventName === 'workflow_dispatch' && dispatchNumber) {
    pullRequest = await getJSON(apiURL(repository, `/pulls/${dispatchNumber}`), token);
    run = {
      id: process.env.GITHUB_RUN_ID ?? 'manual',
      head_sha: pullRequest.head?.sha,
      conclusion: 'success',
      html_url: process.env.GITHUB_SERVER_URL
        ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    };
  } else if (eventName === 'workflow_run' && process.env.WORKFLOW_RUN_ID) {
    run = await getRun(repository, token, process.env.WORKFLOW_RUN_ID);
    if (run.event !== 'pull_request') {
      console.log(`Ignoring CodeQL workflow event ${run.event}.`);
      return;
    }
    pullRequest = await findPullRequest(repository, run, token);
    if (!pullRequest) {
      console.log('The completed CodeQL run is not associated with an open pull request.');
      return;
    }
  } else {
    throw new Error('Unsupported event or missing pull request input');
  }

  if (pullRequest.state !== 'open' || pullRequest.draft) {
    console.log('Ignoring a closed or draft pull request.');
    return;
  }

  const workflowHeadSha = run.head_sha;
  const pullRequestHeadSha = pullRequest.head?.sha;
  if (workflowHeadSha !== pullRequestHeadSha) {
    console.log('Ignoring a superseded CodeQL run for an older pull request head.');
    return;
  }

  let swiftRequired = true;
  let result;
  try {
    ({ swiftRequired, result } = await inspectPullRequest(
      repository,
      token,
      pullRequest,
      workflowHeadSha,
      run.conclusion,
    ));
  } catch (error) {
    result = { pass: false, reasons: [`Unable to verify CodeQL evidence: ${error.message}`] };
  }

  await createCheck(repository, token, {
    headSha: pullRequestHeadSha,
    runId: run.id,
    detailsUrl: run.html_url,
    result,
    swiftRequired,
  });
  if (!result.pass) process.exitCode = 1;
  console.log(checkOutput(result, swiftRequired).summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
