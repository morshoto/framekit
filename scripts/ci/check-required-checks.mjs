import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contexts = ['Lint / static checks', 'Unit / integration tests', 'Swift type-check', 'CodeQL PR policy', 'CI passed'];

export function evaluateRequiredChecks(ruleset) {
  const errors = [];
  if (ruleset.enforcement !== 'active') errors.push('Ruleset must be active');
  const parameters = ruleset.rules?.find(rule => rule.type === 'required_status_checks')?.parameters;
  if (parameters?.strict_required_status_checks_policy !== true) errors.push('Required checks must retain strict commit freshness');
  for (const context of contexts) {
    const check = parameters?.required_status_checks?.find(entry => entry.context === context);
    if (!check) errors.push(`Missing required check: ${context}`);
    else if (check.integration_id !== 15368) errors.push(`${context}: require the GitHub Actions producer (15368)`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, rulesetId] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(rulesetId ?? '')) {
    console.error('Usage: node scripts/ci/check-required-checks.mjs OWNER/REPO RULESET_ID');
    process.exitCode = 2;
  } else {
    try {
      // Read-only audit: a PR must not activate new required checks on main.
      const ruleset = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/rulesets/${rulesetId}`], { encoding: 'utf8' }));
      const errors = evaluateRequiredChecks(ruleset);
      console.log(errors.length ? errors.join('\n') : 'Required CI checks and CodeQL policy are enforced.');
      process.exitCode = errors.length ? 1 : 0;
    } catch (error) {
      console.error(`Cannot verify required checks: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
