import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const repo = process.env.DOCS_GITHUB_REPOSITORY || 'morshoto/framekit';
const runId = process.env.DOCS_DEPLOY_RUN_ID;
const expected = process.env.DOCS_EXPECTED_SHA;
function gh(...args) { return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' })); }
function blocked(message) { throw new Error(`BLOCKED: ${message}`); }
if (!/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(expected || '')) blocked('set DOCS_DEPLOY_RUN_ID and a full DOCS_EXPECTED_SHA');
const run = gh('run', 'view', runId, '--repo', repo, '--json', 'headSha,conclusion,url');
if (run.conclusion !== 'success' || run.headSha !== expected) blocked('workflow run did not succeed at the expected SHA');
const deployments = gh('api', `repos/${repo}/deployments?environment=github-pages&per_page=1`);
const deployment = deployments[0];
if (!deployment || deployment.sha !== expected) blocked('latest Pages deployment does not match the expected SHA');
const status = gh('api', `repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`)[0];
if (status?.state !== 'success' || !status.environment_url || !status.log_url?.includes(`/runs/${runId}`)) blocked('latest successful deployment cannot be tied to this workflow run and URL');
const site = new URL(status.environment_url);
if (site.protocol !== 'https:') blocked('deployment URL is not HTTPS');
const browser = await chromium.launch();
try {
  const page = await browser.newPage(); const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { if (response.url().startsWith(site.href) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  for (const locale of ['en', 'ja']) {
    const response = await page.goto(new URL(`${locale}/docs/introduction/`, site).href, { waitUntil: 'networkidle' });
    if (!response?.ok() || await page.locator('html').getAttribute('lang') !== locale) blocked(`${locale} article did not load correctly`);
    await page.reload({ waitUntil: 'networkidle' });
  }
  await page.getByRole('button', { name: 'Search docs' }).click();
  await page.getByRole('combobox').fill('ランタン');
  await page.getByRole('option').first().waitFor();
  if (failures.length) blocked(`site errors: ${failures.join('; ')}`);
  console.log(`PASS ${expected} ${run.url} ${site.href}`);
} finally { await browser.close(); }
