import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTranscript } from '../../../scripts/benchmarks/ai-editing/caption-quality.mjs';

test('reports substitutions, deletions and insertions against reference words', () => {
  const result = compareTranscript(['one', 'two', 'three', 'four'], ['one', 'too', 'three', 'extra', 'words']);
  assert.equal(result.referenceWords, 4);
  assert.equal(result.errors, 3);
  assert.equal(result.wordErrorRate, 0.75);
  assert.equal(result.substitutions + result.deletions + result.insertions, 3);
});

test('normalizes case and boundary punctuation without discarding fillers', () => {
  const result = compareTranscript(['Um,', 'Hello!'], ['um', 'HELLO.']);
  assert.equal(result.wordErrorRate, 0);
  assert.equal(compareTranscript(['um', 'hello'], ['hello']).deletions, 1);
});

test('does not treat an empty reference as perfect recognition', () => {
  assert.equal(compareTranscript([], ['invented']).wordErrorRate, null);
  assert.equal(compareTranscript([], []).wordErrorRate, null);
});

test('rejects malformed input rather than silently omitting words', () => {
  assert.throws(() => compareTranscript(['hello', '...'], ['hello']), /word/i);
  assert.throws(() => compareTranscript(['hello'], [null]), /word/i);
});

test('screens AMI transcript ordering and leaves automatic timing unverified', async () => {
  const { assessAmiTranscript } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const ref = [
    {start: 60.2, end: 60.7, text: 'hello', speaker: 'B', verification: 'automatic-alignment'},
    {start: 59.9, end: 60.1, text: 'cut', speaker: 'A', verification: 'automatic-alignment'},
    {start: 60.1, end: 60.4, text: 'um', speaker: 'A', verification: 'automatic-alignment'},
  ];
  const result = assessAmiTranscript(ref, [{text: 'Um,', start: 0.1, end: 0.4, confidence: 0.9}, {text: 'hello', start: 0.2, end: 0.7, confidence: 0.2}], 60, 60);
  assert.equal(result.wordErrorRate, 0);
  assert.equal(result.referenceBoundaryWordsExcluded, 1);
  assert.equal(result.overlappingReferencePairs, 1);
  assert.equal(result.lowConfidenceWords, 1);
  assert.equal(result.timingStatus, 'unavailable');
  assert.equal(result.timingScreening.matchedWords, 2);
  assert.equal(result.timingScreening.withinTolerance, 2);
});

test('reports automated boundary disagreement for matched words without asserting accuracy', async () => {
  const { screenWordTiming } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const ref = [
    {text: 'Hello,', start: 1, end: 1.5},
    {text: 'there', start: 2, end: 2.4},
  ];
  const predicted = [
    {text: 'hello', start: 1.1, end: 1.6},
    {text: 'different', start: 2, end: 2.4},
  ];
  const result = screenWordTiming(ref, predicted, 0.2);
  assert.equal(result.matchedWords, 1);
  assert.equal(result.withinTolerance, 1);
  assert.equal(result.referenceWords, 2);
  assert.equal(result.status, 'unavailable');
  assert.equal(screenWordTiming(ref, [], 0.2).withinTolerance, 0);
  assert.throws(() => screenWordTiming(ref, [{text: 'hello', start: 2, end: 1}], 0.2), /timing/i);
});
