import { fileURLToPath } from 'node:url';
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

test('uses published subtitle text without inventing word-level reference times', async () => {
  const { subtitleWords } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello, um.\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld!\n';
  assert.deepEqual(subtitleWords(srt), ['Hello,', 'um.', 'World!']);
  assert.throws(() => subtitleWords('No timestamps here'), /subtitle/i);
});

test('pins a single-speaker source and its coarse subtitle revision', async () => {
  const { loadCorpus } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const corpus = await loadCorpus();
  const source = corpus.supplementalAssets.find((asset) => asset.id === 'nespoli-voice');
  const subtitle = corpus.supplementalAssets.find((asset) => asset.id === 'nespoli-subtitles');
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.match(source.license, /CC BY-SA/);
  assert.match(subtitle.sha256, /^[a-f0-9]{64}$/);
  assert.match(subtitle.url, /oldid=269864367/);
  assert.match(subtitle.timing, /not word-level/i);
});

test('single-speaker runner rejects missing source before running a provider', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-nespoli.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(runner), '/missing/audio', '/missing/srt', 'python'], {stdio: 'pipe'}), /ENOENT/);
});

test('chooses a conservative integral analysis range for rounded container durations', async () => {
  const { safeWholeSecondDuration } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  assert.equal(safeWholeSecondDuration(44.013271), 44);
  assert.throws(() => safeWholeSecondDuration(0.5), /duration/i);
  assert.throws(() => safeWholeSecondDuration(NaN), /duration/i);
});

test('checks caption plan word preservation and timing without claiming rendered accuracy', async () => {
  const { assessCaptionPlan } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const words = [{text:'Hello',start:1,end:1.3},{text:'there',start:1.4,end:1.7}];
  const groups = [{sequenceRange:{start:1,end:1.7}, lines:['Hello there'], words:[{wordIndex:0,text:'Hello'},{wordIndex:1,text:'there'}]}];
  const result = assessCaptionPlan(words, groups, 1/30);
  assert.equal(result.status, 'pass');
  assert.equal(result.renderedTextStatus, 'unavailable');
  assert.equal(assessCaptionPlan(words, [{...groups[0],words:[{wordIndex:0,text:'Hello'},{wordIndex:0,text:'Hello'}]}], 1/30).status, 'fail');
  assert.equal(assessCaptionPlan(words, [{...groups[0],sequenceRange:{start:1.1,end:1.7}}], 1/30).status, 'fail');
  assert.equal(assessCaptionPlan(words, [{...groups[0],words:[{wordIndex:0,text:'changed'},{wordIndex:1,text:'there'}]}], 1/30).status, 'fail');
  assert.equal(assessCaptionPlan(words, [{...groups[0],lines:['Hello']}], 1/30).status, 'fail');
  const reordered = assessCaptionPlan(words, [{...groups[0], lines:['there Hello'], words:[{wordIndex:1,text:'there'},{wordIndex:0,text:'Hello'}]}], 1/30);
  assert.equal(reordered.status, 'fail');
  assert.equal(reordered.orderFailures, 1);
  assert.equal(assessCaptionPlan(words, null, 1/30).status, 'unavailable');
});

test('scores a unique recognized target against human-checked boundaries', async () => {
  const { assessHumanTarget } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const reference={text:'abstract',start:1,end:1.5};
  const word={text:'Abstract,',start:1.1,end:1.6,confidence:0.9};
  assert.equal(assessHumanTarget(reference,[word],0.2).status,'within-tolerance');
  assert.equal(assessHumanTarget(reference,[{...word,end:1.71}],0.2).status,'outside-tolerance');
  assert.equal(assessHumanTarget(reference,[],0.2).status,'missing');
  assert.equal(assessHumanTarget(reference,[word,word],0.2).status,'ambiguous');
  assert.equal(assessHumanTarget(reference,[{...word,text:'the abstract'}],0.2).status,'ambiguous');
  assert.throws(()=>assessHumanTarget({...reference,end:0.5},[word],0.2),/reference/i);
});

test('pins the human-checked target sample and tolerance before inference', async () => {
  const { readFile } = await import('node:fs/promises');
  const c=JSON.parse(await readFile(new URL('../../../scripts/benchmarks/ai-editing/human-timing-case.json',import.meta.url)));
  assert.equal(c.sampleIds.length,20);
  assert.equal(new Set(c.sampleIds).size,20);
  assert.equal(c.toleranceSeconds,0.2);
  assert.equal(c.minimumWithinFraction,0.95);
  assert.match(c.limitation,/read speech/i);
});

test('human timing summary counts missing, ambiguous and unavailable targets', async () => {
  const { summarizeHumanTargets } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const x=summarizeHumanTargets([{status:'within-tolerance'},{status:'outside-tolerance'},{status:'missing'},{status:'ambiguous'},{status:'coverage-unavailable'}],0.95);
  assert.equal(x.total,5);
  assert.equal(x.withinTolerance,1);
  assert.equal(x.withinFraction,0.2);
  assert.equal(x.status,'unavailable');
  assert.equal(summarizeHumanTargets([{status:'within-tolerance'},{status:'missing'}],0.95).status,'fail');
  assert.throws(()=>summarizeHumanTargets([{status:'unknown'}],0.95),/status/i);
});

test('human timing runner verifies the parquet before running an extractor', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner=new URL('../../../scripts/benchmarks/ai-editing/run-human-timing.mjs',import.meta.url);
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(runner),'/missing/parquet','python'],{stdio:'pipe'}),/ENOENT/);
});

test('approved caption probe verifies its input before creating a new output directory', async () => {
  const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareApprovedCaptionOutput } = await import('../../../scripts/benchmarks/ai-editing/caption-approved-preflight.mjs');
  const root = await mkdtemp(join(tmpdir(), 'framekit-caption-preflight-'));
  try {
    const input = join(root, 'source'); const output = join(root, 'output');
    await writeFile(input, 'source');
    const digest = createHash('sha256').update('source').digest('hex');
    await assert.rejects(prepareApprovedCaptionOutput(input, output, '0'.repeat(64)), /digest mismatch/i);
    await assert.rejects(stat(output), {code:'ENOENT'});
    await prepareApprovedCaptionOutput(input, output, digest);
    await assert.rejects(prepareApprovedCaptionOutput(input, output, digest), {code:'EEXIST'});
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('pins the talking-head interview and a fixed evaluation window', async () => {
  const { loadCorpus } = await import('../../../scripts/benchmarks/ai-editing/corpus.mjs');
  const asset = (await loadCorpus()).supplementalAssets.find((item) => item.id === 'novara-interview');
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.match(asset.license, /CC BY 3.0/);
  assert.deepEqual(asset.windowSeconds, [0,30]);
  assert.deepEqual(asset.additionalWindowsSeconds, [[30,60],[60,90]]);
  assert.match(asset.additionalWindowsDesignation, /post hoc/i);
  assert.equal(asset.referenceText, 'unavailable');
});

test('caption probe binds and checks recognized words without asserting speech truth', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { probeCaptionPlan } = await import('../../../scripts/benchmarks/ai-editing/caption-plan-probe.mjs');
  const directory = await mkdtemp(join(tmpdir(),'framekit-caption-probe-'));
  try {
    const path = join(directory,'sample.mp4'); const bytes = Buffer.from('sample'); await writeFile(path,bytes);
    const media = {mediaId:'clip',source:path,sourceDigest:createHash('sha256').update(bytes).digest('hex'),mediaKind:'video',duration:30};
    const revision = {id:'r1',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
    const provider = {id:'speech',provider:'command',version:'1',model:'model',configurationDigest:'config'};
    const output = {words:[{text:'Hello',start:1,end:1.5,confidence:0.7}],requestedRange:{start:0,end:30},observedRange:{start:0,end:30}};
    const result = await probeCaptionPlan(media,revision,provider,output);
    assert.equal(result.planStatus,'available');
    assert.equal(result.assessment.status,'pass');
    assert.equal(result.lowConfidenceWords,1);
    assert.equal(result.renderedTextStatus,'unavailable');
    assert.equal(result.transcriptionAccuracy,'unavailable');
    assert.equal(result.captionGroups, undefined);
    const renderInput = await probeCaptionPlan(media,revision,provider,output,{includeGroups:true});
    assert.equal(renderInput.captionGroups[0].lines[0], 'Hello');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('talking-head runner verifies source identity before inference', async () => {
  const { execFileSync } = await import('node:child_process');
  const runner = new URL('../../../scripts/benchmarks/ai-editing/run-talking-head.mjs',import.meta.url);
  assert.throws(() => execFileSync(process.execPath,['--import','tsx',fileURLToPath(runner),'/missing/video','python'],{stdio:'pipe'}), /ENOENT/);
});

test('headless caption probe samples active frames against a title-free render', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { renderCaptionProbe } = await import('../../../scripts/benchmarks/ai-editing/caption-render-probe.mjs');
  const directory = await mkdtemp(join(tmpdir(),'framekit-caption-render-'));
  try {
    const source = join(directory,'source.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=320x180:r=30:d=2','-c:v','libx264','-threads','1',source]);
    const digest = createHash('sha256').update(await readFile(source)).digest('hex');
    const groups = [{lines:['Hello'],sequenceRange:{start:0.5,end:1,startTime:{value:'1',timescale:'2'},durationTime:{value:'1',timescale:'2'}}}];
    const result = await renderCaptionProbe(source,digest,2,groups,directory);
    assert.equal(result.sampledActiveFrames,2);
    assert.equal(result.framesWithChangedPixels,2);
    assert.equal(result.textAccuracy,'unavailable');
    assert.equal(result.nativeStatus,'unavailable');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('records exact expected text and time for visual caption review', async () => {
  const { captionSampleMetadata } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  assert.deepEqual(captionSampleMetadata({lines:['Hello','world'],sequenceRange:{start:1,end:2}}), {midpointSeconds:1.5,expectedLines:['Hello','world']});
  assert.throws(() => captionSampleMetadata({lines:[],sequenceRange:{start:2,end:1}}), /caption/i);
});

test('identifies recognized words with no frame-start sample', async () => {
  const { sampleFreeWordIndices } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  assert.deepEqual(sampleFreeWordIndices([{start:0,end:0.01},{start:0.01,end:0.02},{start:1/30,end:2/30}],30),[1]);
  assert.throws(() => sampleFreeWordIndices([{start:1,end:0.5}],30), /timing/i);
});

test('selects only fixed exploratory talking-head windows', async () => {
  const { talkingHeadWindow } = await import('../../../scripts/benchmarks/ai-editing/caption-quality.mjs');
  const asset = {windowSeconds:[0,30],additionalWindowsSeconds:[[30,60],[60,90]]};
  assert.deepEqual(talkingHeadWindow(asset,undefined),[0,30]);
  assert.deepEqual(talkingHeadWindow(asset,'second'),[30,60]);
  assert.deepEqual(talkingHeadWindow(asset,'third'),[60,90]);
  assert.throws(() => talkingHeadWindow(asset,'other'), /window/i);
});
