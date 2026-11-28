import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const checkout = process.env.FRAMEKIT_UNCUT_CHECKOUT;
test('digest-bound explicit split selection preserves Uncut output structure', { skip: !checkout && 'set FRAMEKIT_UNCUT_CHECKOUT to the pinned Uncut checkout' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'framekit-uncut-selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'edited.fcpxml'), b = join(dir, 'b.fcpxml'), manifest = join(dir, 'selection.json');
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
  const probe = run('./node_modules/.bin/tsx', ['scripts/research/revision-roundtrip/uncut-probe.ts', checkout, a]);
  assert.equal(probe.status, 0, probe.stderr);
  const digest = createHash('sha256').update(readFileSync(a)).digest('hex');
  const selection = { digest, ordinal: 1, source: 'file:///synthetic/interview.mov', start: '9000/6000s', duration: '3000/6000s', rename: 'Selected split' };
  writeFileSync(manifest, JSON.stringify(selection));
  const script = 'scripts/research/revision-roundtrip/uncut-selection.py';
  const selected = run('python3', [script, a, manifest, b]);
  assert.equal(selected.status, 0, selected.stderr);
  const verify = run('python3', ['scripts/research/revision-roundtrip/verify-uncut-selection.py', a, b]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.notEqual(run('python3', [script, a, manifest, b]).status, 0, 'existing B must not be replaced');
  if (process.env.FRAMEKIT_UNCUT_DTD) {
    const valid = run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_UNCUT_DTD, b]);
    assert.equal(valid.status, 0, valid.stderr);
  }
  const ambiguous = readFileSync(a, 'utf8').replace('start="6000/6000s" offset="0s"', 'start="18000/12000s" offset="0s"');
  assert.notEqual(ambiguous, readFileSync(a, 'utf8'));
  const ambiguousPath = join(dir, 'ambiguous.fcpxml');
  writeFileSync(ambiguousPath, ambiguous);
  writeFileSync(manifest, JSON.stringify({ ...selection, digest: createHash('sha256').update(ambiguous).digest('hex') }));
  assert.notEqual(run('python3', [script, ambiguousPath, manifest, join(dir, 'ambiguous-b.fcpxml')]).status, 0);
  const aliased = ambiguous.replace(/(<asset id="r3"[^\n]*<\/asset>)/, (asset) => `${asset}\n${asset.replace('id="r3"', 'id="r5"')}`)
    .replace('<asset-clip ref="r3" name="Opening"', '<asset-clip ref="r5" name="Opening"');
  assert.notEqual(aliased, ambiguous);
  const aliasPath = join(dir, 'alias.fcpxml');
  writeFileSync(aliasPath, aliased);
  if (process.env.FRAMEKIT_UNCUT_DTD) {
    const validAlias = run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_UNCUT_DTD, aliasPath]);
    assert.equal(validAlias.status, 0, validAlias.stderr);
  }
  writeFileSync(manifest, JSON.stringify({ ...selection, digest: createHash('sha256').update(aliased).digest('hex') }));
  assert.notEqual(run('python3', [script, aliasPath, manifest, join(dir, 'alias-b.fcpxml')]).status, 0, 'same-source aliases must not hide ambiguity');
  for (const source of [
    'file:///synthetic/%69nterview.mov',
    'file://localhost/synthetic/interview.mov',
    'file:///synthetic/dir/../interview.mov',
    'file:///SYNTHETIC/INTERVIEW.MOV',
    'file:///synthetic/%zzinterview.mov',
  ]) {
    const variant = aliased.replace(/(<asset id="r5"[^\n]*src=")file:\/\/\/synthetic\/interview.mov/, `$1${source}`);
    assert.notEqual(variant, aliased);
    const variantPath = join(dir, 'variant.fcpxml');
    writeFileSync(variantPath, variant);
    writeFileSync(manifest, JSON.stringify({ ...selection, digest: createHash('sha256').update(variant).digest('hex') }));
    assert.notEqual(run('python3', [script, variantPath, manifest, join(dir, 'variant-b.fcpxml')]).status, 0, `unsafe URL must be rejected: ${source}`);
  }
  writeFileSync(manifest, JSON.stringify({ ...selection, digest: '0'.repeat(64) }));
  assert.notEqual(run('python3', [script, a, manifest, join(dir, 'stale.fcpxml')]).status, 0);
  writeFileSync(manifest, JSON.stringify({ ...selection, ordinal: 0 }));
  assert.notEqual(run('python3', [script, a, manifest, join(dir, 'wrong.fcpxml')]).status, 0);
});
