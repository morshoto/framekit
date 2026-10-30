import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToolchain } from '../../scripts/check-toolchain.mjs';

const consistent = {
  packageManager: 'pnpm@12.14.0', consumerNode: '>=20', contributorNode: '22.14.0',
  readme: 'Contributor toolchain: Node.js 22.14.0 and pnpm 12.14.0. Consumer runtime: Node.js >=20.',
  contributing: 'Contributor toolchain: Node.js 22.14.0 and pnpm 12.14.0. Consumer runtime: Node.js >=20.',
  gettingStarted: 'Contributor toolchain: Node.js 22.14.0 and pnpm 12.14.0. Consumer runtime: Node.js >=20.',
  workflow: 'NODE_VERSION: 22.14.0',
  hook: 'minimum_node_major=22\nminimum_node_minor=14\nNode.js >=22.14',
  consumerWorkflow: 'CONSUMER_NODE_VERSION: 20.0.0',
};

test('accepts consistent contributor and consumer requirements', () => {
  assert.deepEqual(checkToolchain(consistent), []);
});

test('reports version drift in each documented and executable surface', () => {
  for (const field of ['readme', 'contributing', 'gettingStarted', 'workflow', 'hook']) {
    const errors = checkToolchain({ ...consistent, [field]: 'Node.js 19 and pnpm 1' });
    assert.ok(errors.some((error) => error.includes(field)), field);
  }
});

test('checks the consumer minimum independently of contributor Node', () => {
  assert.ok(checkToolchain({ ...consistent, consumerNode: '>=22' }).some((error) => error.includes('consumer')));
});


test('detects a changed hook comparison even if its message is unchanged', () => {
  const hook = consistent.hook.replace('minimum_node_minor=14', 'minimum_node_minor=15');
  assert.ok(checkToolchain({ ...consistent, hook }).some((error) => error.includes('hook')));
});

test('checks the consumer smoke version against the declared minimum', () => {
  assert.ok(checkToolchain({ ...consistent, consumerWorkflow: 'CONSUMER_NODE_VERSION: 22.0.0' }).some((error) => error.includes('consumerWorkflow')));
});
