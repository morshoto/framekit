import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver } from './receiver.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'share-research-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('persists independent mock exports and rejects replay after restart', async t => {
  const root = await fixture(t);
  const receiver = await createReceiver(root);
  const a = await receiver.create('Example');
  const b = await receiver.create('Example');
  assert.notEqual(a.id, b.id);
  const xml = join(a.directory, 'Example.fcpxml');
  await writeFile(xml, '<fcpxml/>');
  const receipt = await receiver.complete(a.id, [xml]);
  assert.equal(receipt.state, 'observed');
  assert.equal(receipt.files[0].sha256.length, 64);
  assert.equal(receipt.targetVerified, false);
  const restarted = await createReceiver(root);
  assert.equal((await restarted.get(a.id)).state, 'observed');
  await assert.rejects(restarted.complete(a.id, [xml]), /already completed/);
  assert.equal((await restarted.get(b.id)).state, 'pending');
});

test('rejects missing, foreign and symlink outputs without completing', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const receiver = await createReceiver(root);
  const a = await receiver.create('Example');
  await assert.rejects(receiver.complete('unknown', []), /unknown/);
  await assert.rejects(receiver.complete(a.id, []), /empty/);
  await assert.rejects(receiver.complete(a.id, [join(a.directory, 'missing.fcpxml')]));
  const foreign = join(outside, 'Example.fcpxml');
  await writeFile(foreign, 'foreign');
  await assert.rejects(receiver.complete(a.id, [foreign]), /outside/);
  const link = join(a.directory, 'Example.fcpxml');
  await symlink(foreign, link);
  await assert.rejects(receiver.complete(a.id, [link]), /symlink/);
  assert.equal((await receiver.get(a.id)).state, 'pending');
});

test('rejects wrong basenames, duplicate output paths and malformed names', async t => {
  const root = await fixture(t);
  const receiver = await createReceiver(root);
  await assert.rejects(receiver.create('../escape'), /name/);
  const a = await receiver.create('Example');
  const wrong = join(a.directory, 'Other.fcpxml');
  const valid = join(a.directory, 'Example.fcpxml');
  await writeFile(wrong, 'wrong');
  await writeFile(valid, 'valid');
  await assert.rejects(receiver.complete(a.id, [wrong]), /basename/);
  await assert.rejects(receiver.complete(a.id, [valid, valid]), /duplicate/);
  assert.equal((await receiver.get(a.id)).state, 'pending');
});

test('pending mock survives restart and local cancellation rejects late callbacks', async t => {
  const root = await fixture(t);
  const receiver = await createReceiver(root);
  const a = await receiver.create('Example');
  const restarted = await createReceiver(root);
  assert.equal((await restarted.get(a.id)).state, 'pending');
  const cancelled = await restarted.cancel(a.id);
  assert.equal(cancelled.state, 'cancelled');
  const path = join(a.directory, 'Example.fcpxml');
  await writeFile(path, '<fcpxml/>');
  await assert.rejects(restarted.complete(a.id, [path]), /cancelled/);
  assert.equal((await (await createReceiver(root)).get(a.id)).state, 'cancelled');
});

test('a malformed or target-tampered journal cannot accept an output', async t => {
  const root = await fixture(t);
  const receiver = await createReceiver(root);
  const a = await receiver.create('Example');
  const record = join(root, `${a.id}.json`);
  await writeFile(record, '{');
  await assert.rejects(receiver.get(a.id));
  await writeFile(record, JSON.stringify({ ...a, directory: root }));
  await assert.rejects(receiver.complete(a.id, [join(root, 'Example.fcpxml')]), /invalid receipt/);
});

test('mock requires each requested output kind before recording observation', async t => {
  const root = await fixture(t);
  const receiver = await createReceiver(root);
  const asset = await receiver.create('Example', ['xml', 'media']);
  const xml = join(asset.directory, 'Example.fcpxml');
  const media = join(asset.directory, 'Example.mov');
  await writeFile(xml, '<fcpxml/>');
  await writeFile(media, 'synthetic media');
  await assert.rejects(receiver.complete(asset.id, [xml]), /missing requested media/);
  assert.equal((await receiver.get(asset.id)).state, 'pending');
  const receipt = await receiver.complete(asset.id, [xml, media]);
  assert.equal(receipt.state, 'observed');
  assert.deepEqual(receipt.requestedKinds, ['xml', 'media']);
  assert.equal(receipt.targetVerified, false);
});

test('mock rejects malformed requested output kind combinations', async t => {
  const receiver = await createReceiver(await fixture(t));
  await assert.rejects(receiver.create('Example', []), /requested kinds/);
  await assert.rejects(receiver.create('Example', ['media', 'media']), /requested kinds/);
  await assert.rejects(receiver.create('Example', ['archive']), /requested kinds/);
});


test('rejects an asset directory replaced with a symlink before callback', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const receiver = await createReceiver(root);
  const asset = await receiver.create('Example');
  await writeFile(join(outside, 'Example.fcpxml'), '<fcpxml/>');
  await rename(asset.directory, `${asset.directory}-original`);
  await symlink(outside, asset.directory);
  await assert.rejects(receiver.complete(asset.id, [join(asset.directory, 'Example.fcpxml')]), /asset directory/);
  assert.equal((await receiver.get(asset.id)).state, 'pending');
});
