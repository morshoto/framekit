import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function checkToolchain(input) {
  const errors = [];
  const pnpm = input.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  if (!pnpm) errors.push('packageManager must pin an exact pnpm version');
  const node = input.contributorNode ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(node)) errors.push('contributorNode must be an exact version');
  for (const field of ['readme', 'contributing', 'gettingStarted']) {
    if (!(input[field] ?? '').includes(`Contributor toolchain: Node.js ${node} and pnpm ${pnpm}.`)) errors.push(`${field}: contributor versions differ`);
    if (!(input[field] ?? '').includes(`Consumer runtime: Node.js ${input.consumerNode}.`)) errors.push(`${field}: consumer runtime differs`);
  }
  const workflowNode = (input.workflow ?? '').match(/^\s*NODE_VERSION:\s*(\S+)\s*$/m)?.[1];
  if (workflowNode !== node) errors.push('workflow: contributor Node differs');
  const [major, minor] = node.split('.');
  if (!(input.hook ?? '').includes(`minimum_node_major=${major}`) || !(input.hook ?? '').includes(`minimum_node_minor=${minor}`) || !(input.hook ?? '').includes(`Node.js >=${major}.${minor}`)) errors.push('hook: contributor Node minimum differs');
  const consumerMajor = input.consumerNode?.match(/^>=(\d+)$/)?.[1];
  if (!consumerMajor || !(input.consumerWorkflow ?? '').includes(`CONSUMER_NODE_VERSION: ${consumerMajor}.0.0`)) errors.push('consumerWorkflow: consumer minimum differs');
  return errors;
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const read = (path) => readFile(resolve(root, path), 'utf8');
  const manifest = JSON.parse(await read('package.json'));
  const input = {
    packageManager: manifest.packageManager,
    consumerNode: manifest.engines.node,
    contributorNode: (await read('.node-version')).trim(),
    readme: await read('README.md'),
    contributing: await read('CONTRIBUTING.md'),
    gettingStarted: await read('docs/getting-started.md'),
    workflow: await read('.github/workflows/typescript.yml'),
    hook: await read('.githooks/pre-commit'),
    consumerWorkflow: await read('.github/workflows/typescript.yml'),
  };
  const errors = checkToolchain(input);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Toolchain requirements are consistent.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
