import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMediaFixturePool } from '../../support/headless/media-fixtures.js';

test('immutable media setup is built once and copied independently for concurrent consumers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'framekit-media-pool-test-'));
  let builds = 0, generated = '';
  const pool = createMediaFixturePool(async directory => {
    builds++; generated = directory;
    await writeFile(join(directory, 'media.mp4'), 'immutable media');
    await writeFile(join(directory, 'manifest.json'), '{"schemaVersion":1}');
  });
  t.after(async () => { await pool.dispose(); await rm(root, { recursive: true, force: true }); });
  const a = join(root, 'a'), b = join(root, 'b'), c = join(root, 'c');
  await Promise.all([pool.copyTo(a), pool.copyTo(b)]);
  assert.equal(builds, 1);
  assert.equal((await stat(join(generated, 'media.mp4'))).mode & 0o222, 0);
  await writeFile(join(a, 'media.mp4'), 'changed by a race test');
  await pool.copyTo(c);
  assert.equal(await readFile(join(b, 'media.mp4'), 'utf8'), 'immutable media');
  assert.equal(await readFile(join(c, 'media.mp4'), 'utf8'), 'immutable media');
  assert.equal(await readFile(join(c, 'manifest.json'), 'utf8'), '{"schemaVersion":1}');
  await pool.dispose(); await pool.dispose();
  assert.equal(existsSync(generated), false);
  await assert.rejects(pool.copyTo(join(root, 'after-close')), /MEDIA_FIXTURE_POOL_CLOSED/);
});

test('failed media generation retains the first failure and cleans partial setup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'framekit-media-pool-failure-'));
  let builds = 0, generated = '';
  const pool = createMediaFixturePool(async directory => {
    builds++; generated = directory;
    await writeFile(join(directory, 'partial.mp4'), 'partial');
    throw Error('controlled generator failure');
  });
  t.after(async () => { await pool.dispose(); await rm(root, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(pool.copyTo(join(root, String(attempt))), /controlled generator failure/);
  assert.equal(builds, 1, 'do not retry and conceal the original failure');
  assert.equal(existsSync(generated), false);
});
