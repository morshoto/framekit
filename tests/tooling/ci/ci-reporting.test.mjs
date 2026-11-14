import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareTestReport, writeTestSummary } from '../../../scripts/ci/test-reports.mjs';

for (const failing of [false, true]) {
  test(`retains totals, JUnit and provenance for ${failing ? 'failing' : 'passing'} tests`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-reports-'));
    try {
      const fixture = join(dir, 'fixture.test.mjs');
      await writeFile(fixture, `import test from 'node:test';\ntest('case',()=>{${failing ? "throw new Error('expected fixture failure')" : ''}});\ntest.skip('unavailable',()=>{});`);
      const args = await prepareTestReport(dir, 'fixture', { suite: 'all', testedSha: 'merge-sha', candidateSha: 'head-sha', selectedFiles: ['fixture.test.mjs'] });
      const env = { ...process.env, NODE_OPTIONS: '' };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [...args, '--test', fixture], { encoding: 'utf8', env });
      assert.equal(child.status, failing ? 1 : 0, child.stderr);
      const summary = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
      assert.equal(summary.counts.tests, 2);
      assert.equal(summary.counts.skipped, 1);
      assert.equal(summary.counts.failed, failing ? 1 : 0);
      assert.equal(summary.success, !failing);
      assert.match(await readFile(join(dir, 'fixture.xml'), 'utf8'), /<testsuites/);
      const meta = JSON.parse(await readFile(join(dir, 'fixture-metadata.json'), 'utf8'));
      assert.equal(meta.testedSha, 'merge-sha');
      assert.equal(meta.candidateSha, 'head-sha');
      assert.deepEqual(meta.selectedFiles, ['fixture.test.mjs']);
      assert.equal(meta.nodeVersion, process.versions.node);
      const stepSummary = join(dir, 'step-summary.md');
      await writeTestSummary(dir, stepSummary);
      const markdown = await readFile(stepSummary, 'utf8');
      assert.match(markdown, /merge-sha/);
      assert.match(markdown, /head-sha/);
      assert.match(markdown, /fixture/);
      assert.match(markdown, failing ? /failed/ : /passed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('reports an interrupted phase as incomplete without inventing totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-reports-'));
  try {
    await prepareTestReport(dir, 'interrupted', { suite: 'all', testedSha: 'sha', selectedFiles: ['one.test.mjs'] });
    const summary = join(dir, 'summary.md');
    await writeTestSummary(dir, summary);
    assert.match(await readFile(summary, 'utf8'), /incomplete/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('keeps all phase rows together before commit provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-reports-'));
  try {
    for (const phase of ['a', 'b']) {
      await prepareTestReport(dir, phase, { suite: 'all', testedSha: 'sha', selectedFiles: [] });
      await writeFile(join(dir, `${phase}.json`), JSON.stringify({ success: true, counts: { passed: 1, failed: 0, skipped: 0 }, duration_ms: 1 }));
    }
    const summary = join(dir, 'summary.md');
    await writeTestSummary(dir, summary);
    const markdown = await readFile(summary, 'utf8');
    assert.ok(markdown.indexOf('| b / all') < markdown.indexOf('Tested commit'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summarizes actual Docs totals and failure status', async () => {
  const { writeVitestSummary } = await import('../../../scripts/ci/test-reports.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'ci-reports-'));
  try {
    const report = join(dir, 'docs.json');
    const summary = join(dir, 'summary.md');
    await writeFile(report, JSON.stringify({ numTotalTests: 8, numPassedTests: 6, numFailedTests: 1, numPendingTests: 1, success: false }));
    await writeVitestSummary(report, summary);
    const markdown = await readFile(summary, 'utf8');
    assert.match(markdown, /8 tests/);
    assert.match(markdown, /6 passed/);
    assert.match(markdown, /1 failed/);
    assert.match(markdown, /1 skipped/);
    assert.match(markdown, /failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reports slow tests, seed replay diagnostics and reviewed versus unexpected skips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-detailed-reports-'));
  try {
    const fixture = join(dir, 'fixture.test.mjs');
    const reason = 'requires macOS and the CoreMedia SDK; run the SDK job';
    await writeFile(fixture, `import test from 'node:test';
      test('slow case', async t => {
        t.diagnostic('Replay: FRAMEKIT_TEST_SEED=733 pnpm test');
        const started = performance.now();
        do { await new Promise(r => setTimeout(r, 20)); } while (performance.now() - started < 20);
      });
      test('SDK case', { skip: ${JSON.stringify(reason)} }, () => {});
      test.skip('unexplained case', () => {});`);
    const args = await prepareTestReport(dir, 'fixture', { suite: 'all', testedSha: 'sha', selectedFiles: [fixture],
      skipPolicy: [{ file: fixture, name: 'SDK case', reason, platforms: [process.platform] }] });
    const env = { ...process.env, NODE_OPTIONS: '' }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [...args, '--test', fixture], { encoding: 'utf8', env });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
    assert.equal(report.slowest[0].name, 'slow case');
    assert.ok(report.slowest[0].duration_ms >= 20);
    assert.ok(report.reproductions.some(message => message.includes('FRAMEKIT_TEST_SEED=733')));
    const summary = join(dir, 'summary.md'); await writeTestSummary(dir, summary);
    const markdown = await readFile(summary, 'utf8');
    assert.match(markdown, /expected platform.*SDK case/i);
    assert.match(markdown, /unexpected.*unexplained case.*unspecified/i);
    assert.match(markdown, /slow case/);
    assert.match(markdown, /CoreMedia SDK/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('package branch baselines retain unmeasured packages and reject invalid counters', async () => {
  const { summarizePackageCoverage } = await import('../../../scripts/ci/coverage-report.mjs');
  const root = '/fixture';
  const result = summarizePackageCoverage({
    '/fixture/packages/runtime/src/one.ts': { branches: { total: 4, covered: 3 } },
    '/fixture/packages/runtime/src/two.ts': { branches: { total: 6, covered: 2 } },
    '/fixture/adapters/final-cut/typescript/src/native.ts': { branches: { total: 10, covered: 6 } },
    '/outside/packages/runtime/src/one.ts': { branches: { total: 999, covered: 999 } },
  }, root);
  assert.deepEqual(result.find(entry => entry.owner === 'packages/runtime'), { owner: 'packages/runtime', files: 2, total: 10, covered: 5, percent: 50 });
  assert.equal(result.find(entry => entry.owner === 'apps/cli').percent, null);
  assert.throws(() => summarizePackageCoverage({ '/fixture/packages/runtime/src/bad.ts': { branches: { total: 1, covered: 2 } } }, root), /COVERAGE_INVALID/);
});
