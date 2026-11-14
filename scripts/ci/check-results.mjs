import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredJobs = ['lint', 'test', 'nix-fixture', 'consumer-runtime', 'swift', 'docs-changes'];
export const docsJobs = ['docs-foundation', 'docs-export'];

export function evaluateResults(jobs) {
  const errors = [];
  for (const id of requiredJobs) {
    if (jobs[id]?.result !== 'success') errors.push(`${id}: expected success, received ${jobs[id]?.result ?? 'missing'}`);
  }
  const scope = jobs['docs-changes']?.outputs?.changed;
  if (scope !== 'true' && scope !== 'false') errors.push('Docs scope: expected an explicit true or false');
  const maySkipDocs = jobs['docs-changes']?.result === 'success' && scope === 'false';
  for (const id of docsJobs) {
    const result = jobs[id]?.result;
    if (result !== 'success' && !(maySkipDocs && result === 'skipped')) {
      errors.push(`${id}: expected ${maySkipDocs ? 'success or justified skip' : 'success'}, received ${result ?? 'missing'}`);
    }
  }
  for (const id of Object.keys(jobs)) {
    if (![...requiredJobs, ...docsJobs].includes(id)) errors.push(`${id}: job has no aggregate policy`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const jobs = JSON.parse(process.env.CI_JOB_RESULTS);
    const errors = evaluateResults(jobs);
    const summary = ['## CI validation', '', '| Job | Result |', '| --- | --- |',
      ...[...requiredJobs, ...docsJobs].map(id => `| ${id} | ${jobs[id]?.result ?? 'missing'} |`),
      '', ...(errors.length ? errors.map(error => `- ${error}`) : ['All expected validation passed.']), ''].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error(`Cannot verify CI results: ${error.message}`);
    process.exitCode = 1;
  }
}
