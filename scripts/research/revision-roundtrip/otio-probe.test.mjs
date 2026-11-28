import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findAnchoredTarget } from './anchor-identity.mjs';

const run = promisify(execFile);
test('characterizes third-party FCPXML conversion of the authored edit fixture', async t => {
  if (!process.env.FRAMEKIT_OTIO_PYTHON) { t.skip('set FRAMEKIT_OTIO_PYTHON to the pinned disposable environment'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'framekit-otio-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'external.fcpxml');
  const script = new URL('./otio-probe.py', import.meta.url).pathname;
  const input = new URL('./anchored-edit.fcpxml', import.meta.url).pathname;
  const report = JSON.parse((await run(process.env.FRAMEKIT_OTIO_PYTHON, [script, input, output])).stdout);
  assert.equal(report.otioVersion, '0.18.1');
  assert.equal(report.adapterVersion, process.env.FRAMEKIT_OTIO_ADAPTER_VERSION ?? '1.0.0');
  assert.equal(report.input.clips, 3);
  assert.equal(report.input.spineItems, 3);
  assert.equal(report.input.audio, 1);
  assert.equal(report.input.titles, 1);
  assert.equal(report.input.anchors, 3);
  assert.equal(report.output.version, '1.8');
  assert.equal(report.observedTrackCount, 1);
  assert.equal(report.observedClipCount, 4);
  assert.equal(report.missingReferences, 4);
  assert.equal(report.mediaProbe, 'disabled');
  assert.equal(report.output.spineItems, 4);
  assert.ok(report.output.spineNames.includes('Third party edit'));
  assert.equal(report.output.audio, 0);
  assert.equal(report.output.titles, 0);
  assert.equal(report.output.anchors, 0);
  const external = await readFile(output);
  assert.equal(report.output.sha256, createHash('sha256').update(external).digest('hex'));
  const baseline = await readFile(new URL('./anchored-base.fcpxml', import.meta.url), 'utf8');
  assert.throws(() => findAnchoredTarget(baseline, external.toString(), 'opening-v1', { sourceStart: '2s', duration: '1s' }), /invalid XML/);
  const withoutDoctype = external.toString().replace(/<!DOCTYPE fcpxml>/, '');
  assert.notEqual(withoutDoctype, external.toString());
  assert.throws(() => findAnchoredTarget(baseline, withoutDoctype, 'opening-v1', { sourceStart: '2s', duration: '1s' }), /unsupported FCPXML version/);
  if (process.env.FRAMEKIT_OTIO_DTD) {
    await run('xmllint', ['--noout', '--dtdvalid', process.env.FRAMEKIT_OTIO_DTD, output]);
    t.diagnostic('lossy third-party output passed supplied DTD');
  }
  t.diagnostic(JSON.stringify(report));
});
