import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { affectsDocs } from './docs-ci-paths.mjs';

test('detects documentation and shared configuration changes', () => {
  for (const path of ['apps/docs/src/example.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/ci.yml']) assert.equal(affectsDocs(path), true, path);
  assert.equal(affectsDocs('packages/runtime/src/index.ts'), false);
});

test('runs docs checks when change detection cannot determine a diff', () => {
  const result = execFileSync(process.execPath, ['scripts/docs-ci-paths.mjs', 'invalid-base', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(result.trim(), 'true');
});

test('classifies the changes between the merge base and the head', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'docs-ci-'));
  const detector = resolve('scripts/docs-ci-paths.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README'), 'base');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, 'packages', 'runtime'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'runtime', 'file'), 'runtime');
    git('add', '.'); git('commit', '-qm', 'runtime');
    const detect = () => execFileSync(process.execPath, [detector, base, 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(detect(), 'false');
    mkdirSync(join(repo, 'apps', 'docs'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'docs', 'page'), 'docs');
    git('add', '.'); git('commit', '-qm', 'docs');
    assert.equal(detect(), 'true');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
