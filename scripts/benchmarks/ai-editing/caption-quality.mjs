function normalizeWords(words) {
    if (!Array.isArray(words)) throw new Error('Expected word array');
    return words.map((word) => {
      if (typeof word !== 'string') throw new Error('Invalid word');
      const value = word.normalize('NFKC').toLocaleLowerCase('und').replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
      if (!value || /\s/u.test(value)) throw new Error('Invalid word');
      return value;
    });
}

/** Score only an unambiguous model word against a human-checked target interval. */
export function assessHumanTarget(reference, words, tolerance) {
  if (!reference || typeof reference.text !== 'string' || !Number.isFinite(reference.start) || !Number.isFinite(reference.end) || reference.start < 0 || reference.end <= reference.start) throw new Error('Invalid human target reference');
  if (!Array.isArray(words) || !Number.isFinite(tolerance) || tolerance < 0) throw new Error('Invalid target assessment');
  const target=normalizeWords([reference.text])[0], matches=[];
  let multiwordMatch=false;
  for (const word of words) {
    if (typeof word?.text !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) throw new Error('Invalid recognized word');
    const tokens=word.text.trim().split(/\s+/u).filter((token)=>/[\p{L}\p{N}]/u.test(token));
    const normalized=normalizeWords(tokens);
    if (normalized.includes(target)) {
      if (normalized.length!==1) multiwordMatch=true;
      else matches.push(word);
    }
  }
  if (multiwordMatch || matches.length>1) return {status:'ambiguous'};
  if (!matches.length) return {status:'missing'};
  const word=matches[0], startError=word.start-reference.start, endError=word.end-reference.end;
  return {status:Math.abs(startError)<=tolerance+1e-9 && Math.abs(endError)<=tolerance+1e-9 ? 'within-tolerance' : 'outside-tolerance',startErrorSeconds:startError,endErrorSeconds:endError,confidence:word.confidence};
}

/** Classify malformed backend payloads without treating partial coverage as a pass. */
export function assessHumanBackendResponse(stdout, reference, tolerance) {
  assessHumanTarget(reference,[],tolerance);
  let response;
  try { response=JSON.parse(stdout); } catch { return {assessment:{status:'backend-error'},provider:null}; }
  const provider=response?.provider;
  if (!provider || !['id','provider','version'].every((key)=>typeof provider[key]==='string' && provider[key].trim()) || !Array.isArray(response.words)) return {assessment:{status:'backend-error'},provider:null};
  const observed=response.observedRange;
  if (!observed || !Number.isFinite(observed.start) || !Number.isFinite(observed.end) || observed.start<0 || observed.end<=observed.start || observed.start>reference.start || observed.end<reference.end) return {assessment:{status:'coverage-unavailable'},provider};
  try { return {assessment:assessHumanTarget(reference,response.words,tolerance),provider}; }
  catch (error) { if (error instanceof Error && error.message==='Invalid recognized word') return {assessment:{status:'backend-error'},provider}; throw error; }
}

/** Keep every fixed target in the denominator and mark incomplete runs unavailable. */
export function summarizeHumanTargets(rows, minimumFraction) {
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(minimumFraction) || minimumFraction<0 || minimumFraction>1) throw new Error('Invalid target summary');
  const allowed=['within-tolerance','outside-tolerance','missing','ambiguous','coverage-unavailable','backend-error'];
  const counts=Object.fromEntries(allowed.map((key)=>[key,0]));
  for (const row of rows) { if (!allowed.includes(row?.status)) throw new Error('Invalid target status'); counts[row.status]++; }
  const total=rows.length, withinTolerance=counts['within-tolerance'], withinFraction=withinTolerance/total;
  return {status:counts['coverage-unavailable'] || counts['backend-error'] ? 'unavailable' : withinFraction>=minimumFraction ? 'pass' : 'fail',total,withinTolerance,withinFraction,counts};
}

/** Word error rate with case and outer punctuation normalized; no semantic equivalence is assumed. */
export function compareTranscript(reference, hypothesis) {
  const expected = normalizeWords(reference);
  const actual = normalizeWords(hypothesis);
  let row = Array.from({length: actual.length + 1}, (_, i) => ({ errors: i, substitutions: 0, deletions: 0, insertions: i }));
  for (let i = 1; i <= expected.length; i++) {
    const next = [{ errors: i, substitutions: 0, deletions: i, insertions: 0 }];
    for (let j = 1; j <= actual.length; j++) {
      const match = expected[i - 1] === actual[j - 1];
      const diagonal = { ...row[j - 1], errors: row[j - 1].errors + (match ? 0 : 1), substitutions: row[j - 1].substitutions + (match ? 0 : 1) };
      const deletion = { ...row[j], errors: row[j].errors + 1, deletions: row[j].deletions + 1 };
      const insertion = { ...next[j - 1], errors: next[j - 1].errors + 1, insertions: next[j - 1].insertions + 1 };
      next.push([diagonal, deletion, insertion].reduce((best, candidate) => candidate.errors < best.errors ? candidate : best));
    }
    row = next;
  }
  const result = row[actual.length];
  return { ...result, referenceWords: expected.length, hypothesisWords: actual.length, wordErrorRate: expected.length ? result.errors / expected.length : null };
}

/** Exploratory text comparison: AMI's automatic alignment is not a verified timestamp reference. */
export function assessAmiTranscript(reference, recognized, offset, duration) {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid window');
  const end = offset + duration;
  const relevant = reference.filter((word) => word.start < end && word.end > offset);
  const full = relevant.filter((word) => word.start >= offset && word.end <= end)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
  let overlappingReferencePairs = 0;
  for (let i = 0; i < full.length; i++) {
    for (let j = i + 1; j < full.length && full[j].start < full[i].end; j++) {
      if (full[i].speaker !== full[j].speaker) overlappingReferencePairs++;
    }
  }
  const tokens = recognized.flatMap((word) => word.text.trim().split(/\s+/u)).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const result = compareTranscript(full.map((word) => word.text), tokens);
  const timed = recognized.filter((word) => typeof word.text === 'string' && /^[^\s]+$/u.test(word.text.trim()) && /[\p{L}\p{N}]/u.test(word.text)
    && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start);
  const timingScreening = screenWordTiming(full.map((word) => ({...word, start: word.start - offset, end: word.end - offset})), timed, 0.2);
  return { ...result, timingScreening, timingHypothesesExcluded: recognized.length - timed.length, referenceBoundaryWordsExcluded: relevant.length - full.length, overlappingReferencePairs,
    lowConfidenceWords: recognized.filter((word) => word.confidence < 0.8).length,
    timingStatus: 'unavailable',
    limitation: 'Reference timings are automatically aligned; cross-speaker overlap makes linear word order ambiguous.' };
}

/** Compare matching words against automatically aligned references for triage only. */
export function screenWordTiming(reference, hypothesis, tolerance) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Invalid timing tolerance');
  for (const word of [...reference, ...hypothesis]) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start) throw new Error('Invalid word timing');
  }
  const a = normalizeWords(reference.map((word) => word.text));
  const b = normalizeWords(hypothesis.map((word) => word.text));
  const matrix = Array.from({length: a.length + 1}, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    matrix[i][j] = Math.min(matrix[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1), matrix[i-1][j] + 1, matrix[i][j-1] + 1);
  }
  let i = a.length, j = b.length, matchedWords = 0, withinTolerance = 0;
  while (i || j) {
    if (i && j && matrix[i][j] === matrix[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)) {
      if (a[i-1] === b[j-1]) {
        matchedWords++;
        const x = reference[i-1], y = hypothesis[j-1];
        if (Math.abs(x.start - y.start) <= tolerance + 1e-9 && Math.abs(x.end - y.end) <= tolerance + 1e-9) withinTolerance++;
      }
      i--; j--;
    } else if (i && matrix[i][j] === matrix[i-1][j] + 1) i--;
    else j--;
  }
  return { referenceWords: a.length, hypothesisWords: b.length, matchedWords, withinTolerance, toleranceSeconds: tolerance, status: 'unavailable',
    limitation: 'Word matches and reference timestamps are automatic; omissions and ambiguous matches are not timing successes.' };
}

/** Extract text from coarse SRT cues; cue intervals are not word-level ground truth. */
export function subtitleWords(srt) {
  const cues = srt.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/u);
  const words = [];
  for (const cue of cues) {
    const lines = cue.split('\n');
    if (!/^\d+\s*$/u.test(lines[0] ?? '') || !/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/u.test(lines[1] ?? '') || lines.length < 3) throw new Error('Invalid subtitle cue');
    words.push(...lines.slice(2).join(' ').split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)));
  }
  if (!words.length) throw new Error('Empty subtitle');
  return words;
}

/** Do not extend a requested analysis past the decoded sample count on rounded containers. */
export function safeWholeSecondDuration(duration) {
  if (!Number.isFinite(duration) || duration < 1) throw new Error('Invalid source duration');
  return Math.floor(duration);
}

/** Check coverage against recognized words; this does not verify transcript or rendered pixels. */
export function assessCaptionPlan(words, groups, frameDuration) {
  const unavailable = {status:'unavailable',renderedTextStatus:'unavailable'};
  if (!Array.isArray(words) || !words.length || !Array.isArray(groups)) return unavailable;
  if (!Number.isFinite(frameDuration) || frameDuration <= 0) throw new Error('Invalid frame duration');
  const counts = Array(words.length).fill(0);
  let timingFailures = 0, textMismatches = 0, lineMismatches = 0, orderFailures = 0, malformed = 0, previousEnd = 0, previousIndex = -1;
  for (const group of groups) {
    const range = group?.sequenceRange;
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < previousEnd - 1e-9 || range.end <= range.start || !Array.isArray(group.words)) { malformed++; continue; }
    previousEnd = range.end;
    if (!Array.isArray(group.lines) || group.lines.some((line) => typeof line !== 'string')
      || group.lines.join(' ') !== group.words.map((word) => word.text).join(' ')) lineMismatches++;
    for (const item of group.words) {
      const index = item?.wordIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= words.length) { malformed++; continue; }
      if (index <= previousIndex) orderFailures++;
      previousIndex = index;
      counts[index]++;
      const word = words[index];
      if (item.text !== word.text) textMismatches++;
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) { malformed++; continue; }
      if (range.start > word.start + frameDuration + 1e-9 || range.end < word.end - frameDuration - 1e-9) timingFailures++;
    }
  }
  const missingWords = counts.filter((count) => count === 0).length;
  const duplicateWords = counts.filter((count) => count > 1).length;
  return {status:missingWords || duplicateWords || timingFailures || textMismatches || lineMismatches || orderFailures || malformed ? 'fail' : 'pass',
    referenceWords:words.length,missingWords,duplicateWords,timingFailures,textMismatches,lineMismatches,orderFailures,malformed,
    toleranceSeconds:frameDuration,renderedTextStatus:'unavailable'};
}

/** Bind a visual sample to its planned text without claiming recognition accuracy. */
export function captionSampleMetadata(group) {
  const range = group?.sequenceRange;
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start
    || !Array.isArray(group.lines) || !group.lines.length || group.lines.some((line)=>typeof line !== 'string' || !line.trim())) throw new Error('Invalid caption sample');
  return {midpointSeconds:(range.start+range.end)/2,expectedLines:[...group.lines]};
}

/** Find word intervals containing no frame start; timestamps are provider estimates. */
export function sampleFreeWordIndices(words, frameRate) {
  if (!Array.isArray(words) || !Number.isFinite(frameRate) || frameRate <= 0) throw new Error('Invalid word timing');
  return words.flatMap((word,index) => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start) throw new Error('Invalid word timing');
    const firstFrame = Math.ceil(word.start * frameRate - 1e-9);
    return firstFrame / frameRate >= word.end - 1e-9 ? [index] : [];
  });
}

/** Select predeclared windows only; later windows are post hoc exploratory cases. */
export function talkingHeadWindow(asset, selection) {
  const indices = {second:0,third:1};
  if (selection !== undefined && !Object.hasOwn(indices,selection)) throw new Error('Unknown talking-head window');
  const range = selection === undefined ? asset.windowSeconds : asset.additionalWindowsSeconds?.[indices[selection]];
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] - range[0] !== 30) throw new Error('Invalid talking-head window');
  return [...range];
}
