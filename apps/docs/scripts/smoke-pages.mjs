import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { blocked, validateDeployment } from './validate-pages-deployment.mjs';

const repo = process.env.DOCS_GITHUB_REPOSITORY || 'morshoto/framekit';
const runId = process.env.DOCS_DEPLOY_RUN_ID;
const expected = process.env.DOCS_EXPECTED_SHA;
function gh(...args) {
  try { return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { blocked('GitHub CLI could not read deployment evidence; check authentication and network'); }
}
if (!/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(expected || '')) blocked('set DOCS_DEPLOY_RUN_ID and a full DOCS_EXPECTED_SHA');
const run = gh('run', 'view', runId, '--repo', repo, '--json', 'headSha,conclusion,url');
const deployments = gh('api', `repos/${repo}/deployments?environment=github-pages&per_page=1`);
const deployment = deployments[0];
if (!deployment) blocked('no Pages deployment exists');
const status = gh('api', `repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`)[0];
const site = validateDeployment({ runId, expected, run, deployment, status });
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
  await page.getByRole('link', { name: '英語版を読む' }).click();
  await page.getByRole('button', { name: 'Search docs' }).click();
  await page.getByRole('combobox').fill('installation');
  await page.getByRole('option').filter({ hasText: 'Installation' }).first().waitFor();
  if (failures.length) blocked(`site errors: ${failures.join('; ')}`);
  console.log(`PASS ${expected} ${run.url} ${site.href}`);
} finally { await browser.close(); }
