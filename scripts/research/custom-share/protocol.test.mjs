import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProtocol } from './protocol.mjs';
import { createReceiver } from './receiver.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'share-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createProtocol(root);
}

test('models documented callback stages and requested XML/media flags', async t => {
  const protocol = await fixture(t);
  const asset = await protocol.make('Example', ['xml', 'media']);
  const location = await protocol.event(asset.id, 'location');
  assert.equal(location.hasDescription, true);
  assert.equal(location.hasMedia, true);
  assert.equal(location.baseName, 'Example');
  assert.deepEqual(await protocol.event(asset.id, 'library'), { hasArchive: false, hasLibraryDescription: false });
  assert.equal((await protocol.event(asset.id, 'metadata')).shareId, asset.id);
  assert.equal((await protocol.event(asset.id, 'options')).descriptionVersion, '1.11');
  const xml = join(asset.directory, 'Example.fcpxml');
  const movie = join(asset.directory, 'Example.mov');
  await writeFile(xml, '<fcpxml/>');
  await writeFile(movie, 'synthetic');
  assert.equal((await protocol.event(asset.id, 'open', [xml, movie])).state, 'observed');
  assert.deepEqual(protocol.trace(asset.id), ['make', 'location', 'library', 'metadata', 'options', 'open']);
  await assert.rejects(protocol.event(asset.id, 'open', [xml, movie]), /order/);
});

test('isolated sessions reject unknown assets and out-of-order events', async t => {
  const protocol = await fixture(t);
  const a = await protocol.make('Same', ['xml']);
  const b = await protocol.make('Same', ['xml']);
  assert.notEqual(a.id, b.id);
  await assert.rejects(protocol.event('unknown', 'location'), /unknown/);
  await assert.rejects(protocol.event(a.id, 'open', []), /order/);
  await protocol.event(a.id, 'location');
  await assert.rejects(protocol.event(a.id, 'location'), /order/);
  assert.deepEqual(protocol.trace(a.id), ['make', 'location']);
  assert.deepEqual(protocol.trace(b.id), ['make']);
});

test('failed observation stays at open and the mock journal survives restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'share-protocol-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protocol = await createProtocol(root);
  const asset = await protocol.make('Example', ['xml', 'media']);
  for (const event of ['location', 'library', 'metadata', 'options']) await protocol.event(asset.id, event);
  const xml = join(asset.directory, 'Example.fcpxml');
  await writeFile(xml, '<fcpxml/>');
  await assert.rejects(protocol.event(asset.id, 'open', [xml]), /missing requested media/);
  assert.deepEqual(protocol.trace(asset.id), ['make', 'location', 'library', 'metadata', 'options']);
  const restarted = await createProtocol(root);
  assert.deepEqual(await restarted.inspect(asset.id), ['make', 'location', 'library', 'metadata', 'options']);
  const movie = join(asset.directory, 'Example.mov');
  await writeFile(movie, 'synthetic');
  assert.equal((await restarted.event(asset.id, 'open', [xml, movie])).state, 'observed');
  const again = await createProtocol(root);
  await assert.rejects(again.event(asset.id, 'open', [xml, movie]), /order/);
});


test('a partial or mismatched protocol journal stays unknown after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'share-protocol-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protocol = await createProtocol(root);
  const asset = await protocol.make('Example', ['xml']);
  const journal = join(root, `protocol-${asset.id}.json`);
  await writeFile(journal, '{');
  const restarted = await createProtocol(root);
  await assert.rejects(restarted.inspect(asset.id), /journal/);
  await writeFile(journal, JSON.stringify({ id: asset.id, next: 5, trace: ['make'] }));
  await assert.rejects(restarted.event(asset.id, 'open', []), /journal/);
});


test('receipt completed before journal advance remains ambiguous after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'share-protocol-interrupted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protocol = await createProtocol(root);
  const asset = await protocol.make('Example', ['xml']);
  for (const event of ['location', 'library', 'metadata', 'options']) await protocol.event(asset.id, event);
  const xml = join(asset.directory, 'Example.fcpxml');
  await writeFile(xml, '<fcpxml/>');
  await (await createReceiver(root)).complete(asset.id, [xml]);
  const restarted = await createProtocol(root);
  await assert.rejects(restarted.inspect(asset.id), /invalid journal/);
  await assert.rejects(restarted.event(asset.id, 'open', [xml]), /invalid journal/);
});
