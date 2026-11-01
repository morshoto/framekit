import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCodeQLAlert, extractCodeQLAlertNumbers } from './sarif-evidence.mjs';

const SWIFT_CATEGORY = '/language:swift';

function latestSwiftAnalysis(analyses, ref) {
  return analyses.filter((item) => item.ref === ref && item.category === SWIFT_CATEGORY && item.tool?.name === 'CodeQL')
    .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0];
}

export function evaluateSwiftReleasePolicy({ ref, expectedSha, analyses, alerts }) {
  const reasons = [];
  if (!ref?.startsWith('refs/tags/') || !expectedSha) reasons.push('Release tag or commit is missing.');
  if (!Array.isArray(analyses) || !Array.isArray(alerts)) reasons.push('Release CodeQL evidence is unavailable.');
  if (reasons.length) return { pass: false, reasons };

  const analysis = latestSwiftAnalysis(analyses, ref);
  if (!analysis || analysis.commit_sha !== expectedSha) {
    reasons.push('Current Swift CodeQL analysis is missing for the release commit.');
  } else if (analysis.error || !Number.isInteger(analysis.rules_count) || analysis.rules_count <= 0) {
    reasons.push('Swift CodeQL analysis failed or did not load any rules.');
  }

  let blocking = 0;
  for (const alert of alerts) {
    const classification = classifyCodeQLAlert(alert);
    if (classification === 'unknown') {
      reasons.push(`Release alert ${alert.number ?? 'unknown'} has an unknown severity or state.`);
      continue;
    }
    if (classification !== 'blocking') continue;
    const instance = alert.most_recent_instance;
    if (!instance || instance.ref !== ref || instance.commit_sha !== expectedSha) {
      reasons.push(`Current release alert evidence is unavailable for alert ${alert.number ?? 'unknown'}.`);
    } else if (![SWIFT_CATEGORY, '/language:javascript-typescript'].includes(instance.category) ||
      !['open', 'fixed', 'dismissed'].includes(instance.state)) {
      reasons.push(`Release alert ${alert.number} has an unknown category or state.`);
    } else if (instance.category === SWIFT_CATEGORY && instance.state === 'open') {
      blocking++;
    }
  }
  if (blocking) reasons.push(`Found ${blocking} open Swift CodeQL alert(s) at the blocking thresholds.`);
  return { pass: reasons.length === 0, reasons };
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
  const entries = [];
  for (let page = 1; page <= 100; page++) {
    const url = new URL(`https://api.github.com/repos/${repository}${path}`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const batch = await getJSON(url, token);
    if (!Array.isArray(batch)) throw new Error('GitHub API returned a non-list response');
    entries.push(...batch);
    if (batch.length < 100) return entries;
  }
  throw new Error('GitHub API pagination exceeded the safety limit');
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, RELEASE_TAG: tag, RELEASE_SHA: sha } = process.env;
  if (!repository || !token || !tag || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error('Release tag, commit, or GitHub credentials are missing');
  }
  const endpoint = `https://api.github.com/repos/${repository}`;
  const commitURL = `${endpoint}/commits/${encodeURIComponent(tag)}`;
  const commit = await getJSON(commitURL, token);
  if (commit.sha !== sha) throw new Error('Release tag does not resolve to the expected commit');
  const ref = `refs/tags/${tag}`;
  const analyses = await getPages(repository, `/code-scanning/analyses?ref=${encodeURIComponent(ref)}&tool_name=CodeQL`, token);
  const evidence = evaluateSwiftReleasePolicy({ ref, expectedSha: sha, analyses, alerts: [] });
  if (!evidence.pass) throw new Error(evidence.reasons.join('\n'));
  const analysis = latestSwiftAnalysis(analyses, ref);
  if (!Number.isInteger(analysis.id)) throw new Error('Release analysis has no GitHub analysis ID');
  const sarif = await getJSON(`${endpoint}/code-scanning/analyses/${analysis.id}`, token, 'application/sarif+json');
  const numbers = extractCodeQLAlertNumbers(sarif, analysis.results_count);
  const alerts = [];
  for (const number of numbers) {
    const alert = await getJSON(`${endpoint}/code-scanning/alerts/${number}`, token);
    const classification = classifyCodeQLAlert(alert);
    if (classification === 'unknown') throw new Error('CodeQL alert has an unknown severity or state');
    if (classification === 'blocking') {
      const instances = await getPages(repository, `/code-scanning/alerts/${number}/instances?ref=${encodeURIComponent(ref)}`, token);
      const matching = instances.filter((instance) => instance.ref === ref && instance.commit_sha === sha && instance.category === SWIFT_CATEGORY);
      alert.most_recent_instance = matching.find((instance) => instance.state === 'open') ?? matching[0];
    }
    alerts.push(alert);
  }
  const currentCommit = await getJSON(commitURL, token);
  if (currentCommit.sha !== sha) throw new Error('Release tag changed during policy evaluation');
  const result = evaluateSwiftReleasePolicy({ ref, expectedSha: sha, analyses, alerts });
  if (!result.pass) throw new Error(result.reasons.join('\n'));
  console.log(`Swift CodeQL release policy passed for ${tag} at ${sha}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
