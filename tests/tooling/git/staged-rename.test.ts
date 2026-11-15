import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { scanStagedContent } from '../../../scripts/check-staged-content.mjs';

test('renaming an existing fixture scans added lines and retains filename safeguards', async t => {
  const root = await mkdtemp(join(tmpdir(), 'framekit-rename-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, stdio: 'pipe' });
  git('init', '--quiet');
  const existing = ['API', '_KEY', '=', 'fixture-only'].join('') + '\n' + 'safe line\n'.repeat(50);
  await writeFile(join(root, 'old.txt'), existing);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial');
  git('mv', 'old.txt', 'new.txt');
  assert.deepEqual(scanStagedContent(root), []);
  await writeFile(join(root, 'new.txt'), existing + ['ACCESS', '_TOKEN', '=', 'new-value'].join('') + '\n');
  git('add', '.');
  assert.deepEqual(scanStagedContent(root).map(({ path, category }) => ({ path, category })), [{ path: 'new.txt', category: 'credential' }]);
  git('mv', 'new.txt', 'private.mov');
  assert.ok(scanStagedContent(root).some(finding => finding.category === 'private media file'));
});
