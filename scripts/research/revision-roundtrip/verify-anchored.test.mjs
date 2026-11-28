import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const verifier = new URL('./verify-anchored.py', import.meta.url).pathname;

test('independent manifest rejects changed cut placement, source and title effect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-verify-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = (await readFile(new URL('./anchored-edit.fcpxml', import.meta.url), 'utf8'))
    .replace('name="Opening" offset="0s"', 'name="Approved name" offset="0s"');
  const path = join(dir, 'b.fcpxml');
  const verify = () => execFileSync('python3', [verifier, path], { stdio: 'pipe' });
  await writeFile(path, input);
  assert.match(verify().toString(), /manifest verified/);
  for (const [from, to] of [
    ['name="Closing A" offset="1s"', 'name="Closing A" offset="0s"'],
    ['<asset-clip ref="a" name="Closing A"', '<asset-clip ref="m" name="Closing A"'],
    ['<title ref="title-effect"', '<title ref="unrelated-effect"'],
    ['name="Intro" duration="1s"', 'name="Intro" duration="2s"'],
  ]) {
    const changed = input.replace(from, to);
    assert.notEqual(changed, input);
    await writeFile(path, changed);
    assert.throws(verify, undefined, `manifest accepted ${from}`);
  }
});
