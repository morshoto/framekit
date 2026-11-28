import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReceiver, startSender } from './harness.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'generation-fence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generation = join(dir, 'generation');
  const output = join(dir, 'output');
  await writeFile(generation, '1');
  return { generation, output };
}

test('receiver-enforced stale generation rejects delayed operation', async t => {
  const paths = await setup(t);
  const child = await startReceiver({ ...paths, generationId: '1', mode: 'receiver-check' });
  await writeFile(paths.generation, '2');
  assert.equal(await child.execute(), 'rejected-stale');
  await assert.rejects(readFile(paths.output), { code: 'ENOENT' });
});

test('legacy and preaccepted delayed work bypass sender generation', async t => {
  const paths = await setup(t);
  for (const mode of ['legacy', 'check-before-queue']) {
    await writeFile(paths.generation, '1');
    const child = await startReceiver({ ...paths, generationId: '1', mode });
    await writeFile(paths.generation, '2');
    assert.equal(await child.execute(), 'executed');
  }
  assert.equal(await readFile(paths.output, 'utf8'), 'legacy\ncheck-before-queue\n');
});

test('missing or malformed generation fails closed at receiver', async t => {
  const paths = await setup(t);
  for (const generation of ['', 'partial']) {
    const child = await startReceiver({ ...paths, generationId: '1', mode: 'receiver-check' });
    await writeFile(paths.generation, generation);
    assert.equal(await child.execute(), 'rejected-stale');
  }
  const child = await startReceiver({ ...paths, generationId: '1', mode: 'receiver-check' });
  await unlink(paths.generation);
  assert.equal(await child.execute(), 'rejected-stale');
  await assert.rejects(readFile(paths.output), { code: 'ENOENT' });
});

test('generation change after receiver check can still race the write', async t => {
  const paths = await setup(t);
  const child = await startReceiver({ ...paths, generationId: '1', mode: 'check-then-pause' });
  if (typeof child.begin !== 'function') {
    await child.execute();
    assert.fail('receiver has no deterministic check/write barrier');
  }
  assert.equal(await child.begin(), 'checked');
  await writeFile(paths.generation, '2');
  assert.equal(await child.finish(), 'executed');
  assert.equal(await readFile(paths.output, 'utf8'), 'check-then-pause\n');
});


test('killing a sender cannot retract work already handed to another process', async t => {
  const paths = await setup(t);
  const trigger = `${paths.output}.trigger`;
  const before = await startSender({ ...paths, trigger });
  await before.kill();
  await assert.rejects(readFile(paths.output), { code: 'ENOENT' });
  const after = await startSender({ ...paths, trigger });
  await after.dispatch();
  await after.kill();
  await writeFile(trigger, 'continue');
  let actual;
  for (let i = 0; i < 100; i++) {
    try { actual = await readFile(paths.output, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(actual, 'delayed receiver executed\n');
});
