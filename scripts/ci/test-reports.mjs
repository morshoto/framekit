import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareTestReport(directory, phase, metadata) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${phase}-metadata.json`), JSON.stringify({
    ...metadata, nodeVersion: process.versions.node,
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
  for (const file of metadataFiles) {
    const phase = file.slice(0, -'-metadata.json'.length);
    const metadata = JSON.parse(await readFile(join(directory, file), 'utf8'));
    let summary;
    try { summary = JSON.parse(await readFile(join(directory, `${phase}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const counts = summary?.counts;
    lines.push(`| ${phase} / ${metadata.suite} | ${metadata.selectedFiles.length} | ${counts?.passed ?? 'unknown'} | ${counts?.failed ?? 'unknown'} | ${counts?.skipped ?? 'unknown'} | ${summary ? `${(summary.duration_ms / 1000).toFixed(2)}s` : 'unknown'} | ${summary ? (summary.success ? 'passed' : 'failed') : 'incomplete'} |`);
    lines.push(`\nTested commit: \`${metadata.testedSha}\`; candidate: \`${metadata.candidateSha ?? 'not recorded'}\`; Node ${metadata.nodeVersion}; ${metadata.packageManager}.\n`);
  }
  await appendFile(summaryFile, lines.join('\n') + '\n');
}
