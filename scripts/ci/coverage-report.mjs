import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const coverageOwners = [
  'packages/runtime', 'packages/headless-application', 'packages/testkit',
  'adapters/final-cut/typescript', 'adapters/headless/typescript', 'apps/cli', 'apps/mcp-server',
];
export function summarizePackageCoverage(summary, root = process.cwd()) {
  return coverageOwners.map(owner => {
    let files = 0, total = 0, covered = 0;
    for (const [file, entry] of Object.entries(summary)) {
      if (file === 'total' || !relative(root, file).split('\\').join('/').startsWith(`${owner}/src/`)) continue;
      const branches = entry.branches;
      if (!branches || !Number.isSafeInteger(branches.total) || !Number.isSafeInteger(branches.covered)
        || branches.total < 0 || branches.covered < 0 || branches.covered > branches.total) throw Error(`COVERAGE_INVALID: ${owner}`);
      files++; total += branches.total; covered += branches.covered;
    }
    return { owner, files, total, covered, percent: files ? (total ? Number((100 * covered / total).toFixed(2)) : 100) : null };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] ?? 'coverage/coverage-summary.json';
  const summary = JSON.parse(await readFile(input, 'utf8'));
  const packages = summarizePackageCoverage(summary);
  const testedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const outcome = process.env.FRAMEKIT_COVERAGE_TEST_OUTCOME ?? 'see test results';
  const artifact = { testedSha, candidateSha: process.env.FRAMEKIT_HEADLESS_RELEASE_GATE_CANDIDATE_SHA, outcome, packages };
  await writeFile(resolve(input, '../package-branches.json'), JSON.stringify(artifact, null, 2) + '\n');
  const lines = ['## Per-package branch coverage baseline', '', `Tested commit: \`${testedSha}\`; test outcome: ${outcome}.`,
    'Initial observation; no global threshold. Counts describe instrumentation, not native acceptance.', '',
    '| Package | Files | Covered / total branches | Coverage |', '| --- | --- | --- | --- |',
    ...packages.map(p => `| ${p.owner} | ${p.files} | ${p.covered} / ${p.total} | ${p.percent === null ? 'not measured' : p.percent + '%'} |`),
    '', 'Docs app coverage belongs to its separate Vitest runner and is not measured here.', '',
    '### Critical failure-path files', '', '| File | Covered / total branches |', '| --- | --- |'];
  for (const suffix of ['packages/runtime/src/application/project-transactions.ts', 'packages/runtime/src/application/project-store.ts',
    'adapters/final-cut/typescript/src/native.ts', 'adapters/final-cut/typescript/src/canonical.ts']) {
    const entry = summary[resolve(suffix)]?.branches;
    lines.push(`| ${suffix} | ${entry ? `${entry.covered} / ${entry.total}` : 'not measured'} |`);
  }
  const markdown = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
}
