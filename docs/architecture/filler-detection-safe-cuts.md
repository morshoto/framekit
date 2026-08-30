# Deterministic Filler Detection and Safe Cuts

Issue #42 adds two editor-independent runtime components for the speech editing
loop. `FillerDetector` identifies semantic candidates; `SafeCutResolver` decides
whether a candidate can become a physical timeline range. Neither component
mutates a project or calls an editor adapter.

## Coordinate contract

`FillerOccurrence.sourceRange` and `sequenceRange` describe the same-duration
window in source-media and sequence coordinates. Detector word timestamps are
source-relative. The detector maps each candidate into sequence coordinates using
the occurrence offset and rejects unequal-duration or otherwise inconsistent
mappings.

`SafeCutRequest.targetRange` is in sequence coordinates. The candidate's
`sequenceRange` must remain fully inside both this target and the occurrence's
sequence range. The resulting `TimeRange` includes exact rational
`startTime` and `durationTime` values for the sequence frame grid.

## Candidate policy

The detector uses an analyzer's `word.filler` metadata or an exact normalized
vocabulary match. Punctuation at the end of a word is ignored for vocabulary
matching. Candidates below the configured confidence threshold are retained as
evidence with `eligible: false`; this allows a later resolver to return a
`SUGGESTED` decision without permitting automatic application.

Candidate IDs are deterministic hashes of the preview ID, optional analysis
revision, occurrence identity, and source range. Repeating the same candidate
in an expanded or narrowed analysis window preserves its ID; a different
preview produces a different scope.

## Safe-cut policy

The resolver requires valid VAD evidence covering the candidate word. It rejects
overlapping speech, malformed VAD, silence, or protected ranges, ambiguous
source-to-sequence mappings, and protected breath or laughter evidence. A
following silence segment may be trimmed only when it exceeds the configured
preserved pause; the resolver never selects arbitrary silence without evidence.

The candidate word is expanded to frame boundaries only through adjacent safe
silence. Start boundaries are floored and end boundaries are ceiled using exact
rational arithmetic, then clamped against neighboring speech VAD boundaries as
well as transcript words. If either boundary would cross a target, occurrence,
speech, protected segment, or frame-safe interval, the decision is `SKIPPED`.

| Status | Meaning |
| --- | --- |
| `AUTO_APPLY` | Evidence and confidence authorize a safe operation. |
| `SUGGESTED` | The range is safe, but confidence requires review. |
| `SKIPPED` | Evidence or boundaries are insufficient; no operation is returned. |

Every decision carries `evidence` and structured `reasonCodes`. Successful
decisions return an editor-independent `ripple-delete` operation for a caller to
preview and apply through its own transaction and capability policy.

## Fixture boundary

`FixtureSpeechAnalyzer` preserves and range-filters words, VAD, silence, and
protected segments so deterministic tests can exercise the same contract. Fixture
results are test evidence only and do not imply Final Cut capability or live
timeline state.
