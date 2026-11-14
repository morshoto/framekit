import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRequiredChecks } from '../../scripts/ci/check-required-checks.mjs';

const contexts = ['Lint / static checks', 'Unit / integration tests', 'Swift type-check', 'CodeQL PR policy', 'CI passed'];
function ruleset() {
  return { enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })),
  } }] };
}

test('accepts the aggregate alongside every existing required check', () => {
  assert.deepEqual(evaluateRequiredChecks(ruleset()), []);
});
for (const context of contexts) {
  test(`rejects a transition missing ${context}`, () => {
    const rule = ruleset();
    rule.rules[0].parameters.required_status_checks = rule.rules[0].parameters.required_status_checks.filter(check => check.context !== context);
    assert.ok(evaluateRequiredChecks(rule).some(error => error.includes(context)));
  });
}
test('rejects inactive or non-strict rulesets and unbound aggregate producers', () => {
  const rule = ruleset();
  rule.enforcement = 'disabled';
  rule.rules[0].parameters.strict_required_status_checks_policy = false;
  rule.rules[0].parameters.required_status_checks.at(-1).integration_id = null;
  const errors = evaluateRequiredChecks(rule);
  for (const text of ['active', 'strict', 'GitHub Actions']) assert.ok(errors.some(error => error.includes(text)));
});
