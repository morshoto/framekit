import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCodeQLAlert, extractCodeQLAlertNumbers } from './sarif-evidence.mjs';

const JAVASCRIPT_CATEGORY = '/language:javascript-typescript';
const SWIFT_CATEGORY = '/language:swift';

function newestAnalysis(analyses, category, mergeSha, pullRef) {
  return analyses
    .filter((analysis) => analysis.ref === pullRef && analysis.commit_sha === mergeSha &&
      analysis.category === category && analysis.tool?.name === 'CodeQL')
    .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0];
}

export function evaluateCodeQLPolicy({
  workflowHeadSha, pullRequestHeadSha, pullRequestNumber, mergeSha,
  analyses, pullRequestAlerts, baseAlerts, baseSha, baseRef, baseAnalyses,
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
  if (!Number.isInteger(Number(pullRequestNumber)) || Number(pullRequestNumber) < 1) {
    reasons.push('The pull request number is missing or invalid.');
  }
  if (reasons.length > 0) return { pass: false, reasons };

  const expectedRef = `refs/pull/${pullRequestNumber}/merge`;
  const requiredCategories = [JAVASCRIPT_CATEGORY];
  for (const category of requiredCategories) {
    const analysis = newestAnalysis(analyses, category, mergeSha, expectedRef);
    if (!analysis) {
      reasons.push(`Missing current ${category} CodeQL analysis.`);
    } else {
      if (analysis.error) reasons.push(`${category} CodeQL analysis failed: ${analysis.error}`);
      if (!Number.isInteger(analysis.rules_count) || analysis.rules_count <= 0) {
        reasons.push(`${category} CodeQL analysis did not load any rules.`);
      }
    }
  }

  if (baseSha || baseRef || baseAnalyses) {
    const baseline = Array.isArray(baseAnalyses) && baseAnalyses
      .filter((analysis) => analysis.ref === baseRef && analysis.category === JAVASCRIPT_CATEGORY && analysis.tool?.name === 'CodeQL')
      .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0];
    if (!baseline || baseline.commit_sha !== baseSha || baseline.error || !Number.isInteger(baseline.rules_count) || baseline.rules_count <= 0) {
      reasons.push('Current JavaScript CodeQL analysis is missing for the pull request base.');
    }
  }

  const baselineAlerts = new Map(baseAlerts.filter((alert) => alert.state === 'open').map((alert) => [String(alert.number), alert]));
  let newBlockingAlerts = 0;
  for (const alert of pullRequestAlerts) {
    const classification = classifyCodeQLAlert(alert);
    if (classification === 'unknown') {
      reasons.push(`CodeQL alert ${alert.number ?? 'unknown'} has an unknown severity or state.`);
      continue;
    }
    if (classification !== 'blocking') continue;
    const baselineAlert = baselineAlerts.get(String(alert.number));
    if (baselineAlert) {
      const instance = baselineAlert.most_recent_instance;
      if (baseSha && (!instance || instance.ref !== baseRef || instance.commit_sha !== baseSha || instance.state !== 'open')) {
        reasons.push(`Current base alert evidence is unavailable for alert ${alert.number}.`);
      }
      continue;
    }
    const instances = alert.instances?.filter((instance) => instance.ref === expectedRef && instance.commit_sha === mergeSha);
    if (!instances?.length) {
      reasons.push(`Current CodeQL alert evidence is unavailable for alert ${alert.number ?? 'unknown'}.`);
    } else if (instances.some((instance) => ![JAVASCRIPT_CATEGORY, SWIFT_CATEGORY].includes(instance.category) ||
      !['open', 'fixed', 'dismissed'].includes(instance.state))) {
      reasons.push(`CodeQL alert ${alert.number} has an unknown category or state.`);
    } else if (instances.some((instance) => instance.state === 'open' && requiredCategories.includes(instance.category))) {
      newBlockingAlerts++;
    }
  }
  if (newBlockingAlerts > 0) reasons.push(`Found ${newBlockingAlerts} new CodeQL alert(s) at the blocking thresholds.`);
  return { pass: reasons.length === 0, reasons };
}

function apiURL(repository, path) {
  return `https://api.github.com/repos/${repository}${path}`;
}

async function getJSON(url, token, accept = 'application/vnd.github+json') {
  const response = await fetch(url, { headers: {
    Accept: accept, Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  } });
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

export async function verifyCurrentPullRequestPolicy({
  repository, token, pullRequestNumber, expectedHeadSha, expectedBaseSha, expectedMergeSha,
}) {
  if (!repository || !token || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1 ||
      !expectedHeadSha || !expectedBaseSha || !expectedMergeSha) {
    throw new Error('Missing pull request identity or GitHub credentials');
  }
  const number = String(pullRequestNumber);
  const pullRequest = await getJSON(apiURL(repository, `/pulls/${number}`), token);
  const baseRef = pullRequest.base?.ref;
  if (!baseRef || pullRequest.head?.sha !== expectedHeadSha || pullRequest.base?.sha !== expectedBaseSha ||
      pullRequest.merge_commit_sha !== expectedMergeSha) {
    throw new Error('Pull request head, base, or merge commit changed before policy evaluation');
  }
  const branchPath = `/branches/${encodeURIComponent(baseRef)}`;
  const branch = await getJSON(apiURL(repository, branchPath), token);
  if (branch.commit?.sha !== expectedBaseSha) throw new Error('The pull request base branch changed');

  const pullRef = `refs/pull/${number}/merge`;
  const baseRefName = `refs/heads/${baseRef}`;
  const [analyses, baseAlerts, baseAnalyses] = await Promise.all([
    getPages(repository, `/code-scanning/analyses?ref=${encodeURIComponent(pullRef)}&tool_name=CodeQL`, token),
    getPages(repository, `/code-scanning/alerts?ref=${encodeURIComponent(baseRefName)}&tool_name=CodeQL&state=open`, token),
    getPages(repository, `/code-scanning/analyses?ref=${encodeURIComponent(baseRefName)}&tool_name=CodeQL`, token),
  ]);
  const analysis = newestAnalysis(analyses, JAVASCRIPT_CATEGORY, expectedMergeSha, pullRef);
  if (!analysis || analysis.error || !Number.isInteger(analysis.rules_count) || analysis.rules_count <= 0 || !Number.isInteger(analysis.id)) {
    throw new Error('Current JavaScript CodeQL analysis is missing or failed');
  }
  const sarif = await getJSON(apiURL(repository, `/code-scanning/analyses/${analysis.id}`), token, 'application/sarif+json');
  const numbers = extractCodeQLAlertNumbers(sarif, analysis.results_count);
  const pullRequestAlerts = [];
  for (const alertNumber of numbers) {
    pullRequestAlerts.push(await getJSON(apiURL(repository, `/code-scanning/alerts/${alertNumber}`), token));
  }
  const baselineNumbers = new Set(baseAlerts.map((alert) => String(alert.number)));
  for (const alert of pullRequestAlerts) {
    const classification = classifyCodeQLAlert(alert);
    if (classification === 'unknown') throw new Error('CodeQL alert has an unknown severity or state');
    if (classification === 'blocking' && !baselineNumbers.has(String(alert.number))) {
      if (!Number.isInteger(alert.number)) throw new Error('CodeQL alert has no valid number');
      alert.instances = await getPages(repository,
        `/code-scanning/alerts/${alert.number}/instances?ref=${encodeURIComponent(pullRef)}`, token);
    }
  }
  const [currentPull, currentBranch] = await Promise.all([
    getJSON(apiURL(repository, `/pulls/${number}`), token),
    getJSON(apiURL(repository, branchPath), token),
  ]);
  if (currentPull.head?.sha !== expectedHeadSha || currentPull.base?.sha !== expectedBaseSha ||
      currentPull.merge_commit_sha !== expectedMergeSha || currentBranch.commit?.sha !== expectedBaseSha) {
    throw new Error('Pull request evidence became stale during policy evaluation');
  }
  return evaluateCodeQLPolicy({
    workflowHeadSha: expectedHeadSha, pullRequestHeadSha: currentPull.head.sha, pullRequestNumber,
    mergeSha: expectedMergeSha, analyses, pullRequestAlerts, baseAlerts,
    baseSha: expectedBaseSha, baseRef: baseRefName, baseAnalyses,
  });
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, PR_NUMBER: number,
    PR_HEAD_SHA: headSha, PR_BASE_SHA: baseSha, GITHUB_SHA: mergeSha } = process.env;
  if (!/^\d+$/.test(number ?? '')) throw new Error('Missing pull request identity or GitHub credentials');
  const result = await verifyCurrentPullRequestPolicy({
    repository, token, pullRequestNumber: Number(number), expectedHeadSha: headSha,
    expectedBaseSha: baseSha, expectedMergeSha: mergeSha,
  });
  if (!result.pass) throw new Error(result.reasons.join('\n'));
  console.log('Current JavaScript/TypeScript CodeQL analysis satisfies the pull request policy.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
