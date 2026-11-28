import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSources } from './inspect.mjs';

const sources = {
  patch: 'Injects it into the FCP binary (LC_LOAD_DYLIB)\ncodesign --force',
  server: '@selector(undoManager)\nif (um) {\n[um beginUndoGrouping];',
  contents: 'hs.axuielement\nAXUIElementDestroyed',
  version: 'fcp.EARLIEST_SUPPORTED_VERSION = semver("10.4.4")',
};

test('reports pinned source anchors without claiming runtime guarantees', () => {
  const report = inspectSources(sources);
  assert.equal(report.anchors.injection, true);
  assert.equal(report.anchors.signing, true);
  assert.equal(report.anchors.undoManager, true);
  assert.equal(report.anchors.accessibility, true);
  assert.equal(report.anchors.versionFloor, true);
  assert.equal(report.hashes.patch.length, 64);
  assert.equal(report.runtimeVerified, false);
  assert.equal(report.recoveryVerified, false);
});

test('missing anchors remain unknown instead of proving absence', () => {
  const report = inspectSources({ ...sources, server: '', patch: '' });
  assert.equal(report.anchors.injection, false);
  assert.equal(report.anchors.undoManager, false);
  assert.equal(report.runtimeVerified, false);
  assert.equal(report.recoveryVerified, false);
});

test('rejects missing or non-text source inputs', () => {
  assert.throws(() => inspectSources({ ...sources, contents: null }), /invalid source/);
});
