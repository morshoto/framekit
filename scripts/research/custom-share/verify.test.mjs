import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReceiver } from './receiver.mjs';
import { inspectXml } from './verify.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'share-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'output.fcpxml');
}

test('checks XML syntax and independently expected digest', async t => {
  const path = await fixture(t);
  const xml = '<fcpxml version="1.11"><resources/></fcpxml>';
  await writeFile(path, xml);
  const result = await inspectXml(path, digest(xml));
  assert.equal(result.digestMatches, true);
  assert.equal(result.wellFormedFcpxml, true);
  assert.equal(result.targetVerified, false);
  await writeFile(path, xml.replace('1.11', '1.10'));
  assert.equal((await inspectXml(path, digest(xml))).digestMatches, false);
});

test('rejects malformed XML and a different root independently of digest', async t => {
  const path = await fixture(t);
  for (const xml of ['<fcpxml><broken></fcpxml>', '<not-fcpxml/>']) {
    await writeFile(path, xml);
    const result = await inspectXml(path, digest(xml));
    assert.equal(result.digestMatches, true);
    assert.equal(result.wellFormedFcpxml, false);
  }
});

test('rejects missing files, symlinks, and invalid expected digests', async t => {
  const path = await fixture(t);
  await assert.rejects(inspectXml(path, 'a'.repeat(64)));
  await writeFile(`${path}.actual`, '<fcpxml/>');
  await symlink(`${path}.actual`, path);
  await assert.rejects(inspectXml(path, 'a'.repeat(64)), /symlink/);
  await assert.rejects(inspectXml(path, 'not-a-hash'), /digest/);
});


test('independent inspection detects changed bytes after a mock callback', async t => {
  const path = await fixture(t);
  const receiver = await createReceiver(dirname(path));
  const asset = await receiver.create('Example');
  const output = join(asset.directory, 'Example.fcpxml');
  const expected = '<fcpxml version="1.11"><resources/></fcpxml>';
  await writeFile(output, expected);
  const receipt = await receiver.complete(asset.id, [output]);
  assert.equal(receipt.files[0].sha256, digest(expected));
  assert.equal((await inspectXml(output, digest(expected))).digestMatches, true);
  await writeFile(output, expected.replace('1.11', '1.10'));
  assert.equal((await inspectXml(output, digest(expected))).digestMatches, false);
  assert.equal((await receiver.get(asset.id)).state, 'observed');
});
