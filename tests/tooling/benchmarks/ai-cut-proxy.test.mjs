import assert from 'node:assert/strict';
import {test} from 'node:test';
import { compareRecognizedWords, prepareCutPcm } from '../../../scripts/benchmarks/ai-editing/cut-proxy.mjs';

test('counts missing and added recognized words without claiming continuity', () => {
  const r = compareRecognizedWords(['Well,','well','hello'], ['well','hello','new']);
  assert.equal(r.baselineWords,3);
  assert.equal(r.matchedWords,2);
  assert.equal(r.missingWords,1);
  assert.equal(r.addedWords,1);
  assert.equal(r.continuity,'unavailable');
  assert.equal(compareRecognizedWords([], ['new']).retention,null);
});

test('prepares an exact sample cut and rejects invalid boundaries', () => {
  const input = Buffer.from([1,0,2,0,3,0,4,0,5,0]);
  const pair = prepareCutPcm(input,1,3);
  assert.deepEqual([...pair.original],[...input]);
  assert.deepEqual([...pair.cut],[1,0,4,0,5,0]);
  assert.throws(()=>prepareCutPcm(input,3,2),/range/i);
  assert.throws(()=>prepareCutPcm(Buffer.from([1]),0,1),/PCM/i);
});
