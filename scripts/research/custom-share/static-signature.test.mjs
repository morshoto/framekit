import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyStaticSignature } from './verify-static-signature.mjs';

const run = promisify(execFile);
test('pinned Final Cut requirement rejects a separately compiled test program', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'framekit-signature-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'main.swift');
  const binary = join(dir, 'mock-sender');
  await writeFile(source, 'print("synthetic")\n');
  await run('xcrun', ['swiftc', source, '-o', binary]);
  await assert.rejects(verifyStaticSignature(binary));
  await assert.rejects(verifyStaticSignature(join(dir, 'missing.app')));
});
