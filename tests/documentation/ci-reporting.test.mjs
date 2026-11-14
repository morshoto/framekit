import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareTestReport, writeTestSummary } from '../../scripts/ci/test-reports.mjs';

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
