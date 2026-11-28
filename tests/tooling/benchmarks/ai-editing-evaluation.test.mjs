import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCuts } from '../../../scripts/benchmarks/ai-editing/evaluate.mjs';

test('scores verified protected speech overlap without counting boundary contact', () => {
  const result = assessCuts([{start: 1, end: 2}, {start: 4, end: 5}], [
    {start: 2, end: 3, verification: 'human-verified'},
    {start: 4.5, end: 4.8, verification: 'human-verified'},
  ]);
  assert.equal(result.verifiedSpeechOverlaps, 1);
  assert.equal(result.status, 'fail');
});

test('does not call unverified reference timing safe or count it as measured truth', () => {
  const result = assessCuts([{start: 1, end: 2}], [{start: 1.2, end: 1.5, verification: 'automatic-alignment'}]);
  assert.equal(result.verifiedSpeechOverlaps, 0);
  assert.equal(result.unverifiedReferenceOverlaps, 1);
  assert.equal(result.status, 'unavailable');
});

test('requires complete human-reviewed coverage before reporting a pass', () => {
  const result = assessCuts([{start: 1, end: 2}], [], {coverage: 'partial'});
  assert.equal(result.status, 'unavailable');
});

test('rejects invalid ranges rather than overlooking an unsafe candidate', () => {
  assert.throws(() => assessCuts([{start: 2, end: 1}], []), /range/i);
});

test('passes only when every proposed cut is covered by reviewed audio', () => {
  const cuts = [{start: 1, end: 2}, {start: 4, end: 5}];
  const words = [{start: 2, end: 3, verification: 'human-verified'}];
  assert.equal(assessCuts(cuts, words, {reviewedRanges: [{start: 0, end: 3}]}).status, 'unavailable');
  assert.equal(assessCuts(cuts, words, {reviewedRanges: [{start: 0, end: 3}, {start: 4, end: 6}]}).status, 'pass');
  assert.equal(assessCuts([], words, {reviewedRanges: [{start: 0, end: 6}]}).status, 'unavailable');
});
