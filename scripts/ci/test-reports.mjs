import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareTestReport(directory, phase, metadata) {
  await mkdir(directory, { recursive: true });
  const skipPolicy = await Promise.all((metadata.skipPolicy ?? []).map(async rule => ({ ...rule, file: await realpath(rule.file) })));
  await writeFile(join(directory, `${phase}-metadata.json`), JSON.stringify({
    ...metadata, skipPolicy, platform: process.platform, repositoryRoot: process.cwd(), nodeVersion: process.versions.node,
    packageManager: process.env.npm_config_user_agent ?? 'not recorded',
  }, null, 2) + '\n');
  return [
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${join(directory, `${phase}.xml`)}`,
    `--test-reporter=${fileURLToPath(new URL('./test-summary.mjs', import.meta.url))}`,
    `--test-reporter-destination=${join(directory, `${phase}.json`)}`,
  ];
}

export async function writeTestSummary(directory, summaryFile) {
  if (!summaryFile) return;
  const metadataFiles = (await readdir(directory)).filter(file => file.endsWith('-metadata.json')).sort();
  const lines = ['## Deterministic test results', '', '| Phase / suite | Files | Passed | Failed | Skipped | Duration | Result |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const provenance = [];
  const details = [];
  for (const file of metadataFiles) {
    const phase = file.slice(0, -'-metadata.json'.length);
    const metadata = JSON.parse(await readFile(join(directory, file), 'utf8'));
    let summary;
    try { summary = JSON.parse(await readFile(join(directory, `${phase}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const counts = summary?.counts;
    lines.push(`| ${phase} / ${metadata.suite} | ${metadata.selectedFiles.length} | ${counts?.passed ?? 'unknown'} | ${counts?.failed ?? 'unknown'} | ${counts?.skipped ?? 'unknown'} | ${summary ? `${(summary.duration_ms / 1000).toFixed(2)}s` : 'unknown'} | ${summary ? (summary.success ? 'passed' : 'failed') : 'incomplete'} |`);
    if (summary?.slowest?.length) {
      details.push('', `### Slowest tests: ${phase}`, '', '| Test | File | Duration |', '| --- | --- | --- |');
      for (const entry of summary.slowest) details.push(`| ${cell(entry.name)} | ${cell(relative(metadata.repositoryRoot, entry.file ?? ''))} | ${entry.duration_ms.toFixed(2)}ms |`);
    }
    if (summary?.skips?.length) {
      details.push('', `### Skips: ${phase}`, '', '| Classification | Test | Reason / expected environment |', '| --- | --- | --- |');
      for (const skip of summary.skips) {
        const reviewed = metadata.skipPolicy?.find(rule => resolve(rule.file) === resolve(skip.file)
          && rule.name === skip.name && rule.reason === skip.reason
          && (rule.platforms.includes('any') || rule.platforms.includes(metadata.platform)));
        const classification = /does not match.*pattern/.test(skip.reason) ? 'name filter' : reviewed ? `expected ${reviewed.kind ?? 'platform'}` : 'unexpected';
        details.push(`| ${classification} | ${cell(skip.name)} | ${cell(skip.reason)} |`);
      }
    }
    if (summary?.reproductions?.length) details.push('', 'Seed replay diagnostics are retained in the JSON and JUnit artifacts.');
    provenance.push(`\nTested commit: \`${metadata.testedSha}\`; candidate: \`${metadata.candidateSha ?? 'not recorded'}\`; Node ${metadata.nodeVersion}; ${metadata.packageManager}.\n`);
  }
  await appendFile(summaryFile, [...lines, ...provenance, ...details].join('\n') + '\n');
}

export async function writeVitestSummary(reportFile, summaryFile) {
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  const markdown = `## Docs unit tests

${report.numTotalTests} tests: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped. Result: ${report.success ? 'passed' : 'failed'}.
`;
  if (summaryFile) await appendFile(summaryFile, markdown);
  return markdown;
}

function cell(value) { return String(value).replaceAll('|', String.fromCharCode(92) + '|').replaceAll(String.fromCharCode(10), ' '); }
