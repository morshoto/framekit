import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRevision, reconcileOccurrences } from './matching.mjs';

const digest = value => value.repeat(64);
const clip = (id, start, extra = {}) => ({ id, sourceDigest: digest('a'), sourceStart: start, duration: '3/1', ...extra });

test('preserves a unique source interval despite same-name insertion and timeline movement', () => {
  const base = [clip('original', '1/1', { name: 'Opening', offset: '0/1' })];
  const observed = [clip('new-position-0', '4/1', { name: 'Opening', offset: '0/1' }), clip('new-position-1', '1/1', { name: 'Opening', offset: '1/1' })];
  const result = reconcileOccurrences(base, observed);
  assert.deepEqual(result.matches, [{ baseId: 'original', observedId: 'new-position-1' }]);
  assert.deepEqual(result.inserted, ['new-position-0']);
});

test('rejects indistinguishable repeated sources and changed source intervals', () => {
  assert.throws(() => reconcileOccurrences([clip('original', '1/1')], [clip('one', '1/1'), clip('two', '1/1')]), /ambiguous/);
  assert.throws(() => reconcileOccurrences([clip('one', '1/1'), clip('two', '1/1')], [clip('only', '1/1')]), /ambiguous/);
  assert.throws(() => reconcileOccurrences([clip('original', '1/1')], [clip('changed', '2/1')]), /missing/);
});

test('rejects missing source digest and duplicate occurrence identifiers', () => {
  assert.throws(() => reconcileOccurrences([clip('one', '1/1', { sourceDigest: '' })], []), /invalid/);
  assert.throws(() => reconcileOccurrences([clip('same', '1/1'), clip('same', '4/1')], []), /invalid/);
});

test('revision binds exact artifact bytes and rejects stale baseline', () => {
  const revision = bindRevision(Buffer.from('<fcpxml/>'));
  assert.match(revision.digest, /^[a-f0-9]{64}$/);
  assert.equal(bindRevision(Buffer.from('<fcpxml/>'), revision.digest).digest, revision.digest);
  assert.throws(() => bindRevision(Buffer.from('<fcpxml />'), revision.digest), /stale/);
});

test('matches equivalent rational intervals and rejects invalid ranges', () => {
  assert.deepEqual(reconcileOccurrences([clip('base', '2/2', { duration: '6/2' })], [clip('observed', '1/1')]).matches,
    [{ baseId: 'base', observedId: 'observed' }]);
  assert.throws(() => reconcileOccurrences([clip('base', '-1/1')], []), /invalid/);
  assert.throws(() => reconcileOccurrences([clip('base', '1/1', { duration: '0/1' })], []), /invalid/);
  assert.throws(() => reconcileOccurrences([clip('base', '1/1', { duration: '-1/1' })], []), /invalid/);
});

test('finds a unique unchanged target when an unrelated clip is cut', async () => {
  const { locateTarget } = await import('./matching.mjs');
  const base = [clip('target', '1/1', { duration: '1/1' }), clip('other', '3/1', { duration: '2/1' })];
  const observed = [clip('target-now', '1/1', { duration: '1/1' }), clip('other-cut', '3/1', { duration: '1/1' })];
  assert.equal(locateTarget(base, observed, 'target'), 'target-now');
  assert.throws(() => locateTarget(base, [...observed, clip('identical', '1/1', { duration: '1/1' })], 'target'), /ambiguous/);
  assert.throws(() => locateTarget(base, observed, 'unknown'), /missing/);
});
