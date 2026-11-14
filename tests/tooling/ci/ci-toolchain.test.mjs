import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

async function check(args, { xcode = '26.6', sdk = '26.5', build = '17F113', developerDir } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ci-xcode-'));
  try {
    const commands = {
      'xcode-select': `printf '%s\\n' '/Applications/Xcode_${xcode}.app/Contents/Developer'`,
      xcodebuild: `printf 'Xcode %s\\nBuild version %s\\n' '${xcode}' '${build}'`,
      xcrun: `printf '%s\\n' '${sdk}'`,
    };
    for (const [name, command] of Object.entries(commands)) await writeFile(join(directory, name), `#!/bin/bash\n${command}\n`, { mode: 0o755 });
    await symlink(process.execPath, join(directory, 'node'));
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
    delete env.DEVELOPER_DIR;
    if (developerDir) env.DEVELOPER_DIR = developerDir;
    return spawnSync('bash', ['nix/check-xcode.sh', ...args], { env, encoding: 'utf8' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('explicit CI profile accepts its exact Xcode, build and SDK', async () => {
  const result = await check(['--ci']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const [field, value] of [['xcode', '26.5'], ['sdk', '26.4'], ['build', 'unexpected']]) {
  test(`CI profile fails closed for mismatched ${field}`, async () => {
    const result = await check(['--ci'], { [field]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /mismatch/);
  });
}

test('default native validation retains the local compatibility baseline', async () => {
  const manifest = JSON.parse(await readFile('nix/xcode-version.json', 'utf8'));
  const result = await check([], { xcode: manifest.target.xcode.version, sdk: manifest.target.macOSSDK, build: 'local-build' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('CI honors an explicitly selected developer directory', async () => {
  const result = await check(['--ci'], { developerDir: '/Library/Developer/CommandLineTools' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /full Xcode/);
});

test('unknown toolchain profiles are rejected', async () => {
  const result = await check(['--unknown'], { xcode: '16.4', sdk: '15.5' });
  assert.notEqual(result.status, 0);
});

test('Swift CI selects its declared profile before shim validation', async () => {
  const action = await readFile('.github/action/swift/action.yml', 'utf8');
  assert.match(action, /xcode-version.json/);
  assert.match(action, /GITHUB_ENV/);
  assert.match(action, /bash nix\/check-xcode.sh --ci/);
  assert.match(action, /shim/);
  assert.match(action, /does not.*build.*extension/);
});
