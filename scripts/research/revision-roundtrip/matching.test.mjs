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
