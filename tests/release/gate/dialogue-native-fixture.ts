import { createHash } from "node:crypto";
// Synthetic contract inputs only. Never persist these as native execution receipts.
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const reasons: Record<string, string> = { silent: "SILENCE", "no-dialogue": "NO_DIALOGUE", "too-short": "DIALOGUE_TOO_SHORT", "gain-limits": "GAIN_OUT_OF_BOUNDS", "peak-risk": "PEAK_RISK", "malformed-measurement": "ANALYSIS_INVALID", "stale-preview": "STALE_CONTEXT", "provider-mismatch": "ANALYSIS_INVALID", "range-mismatch": "ANALYSIS_INVALID", "revision-mismatch": "ANALYSIS_STALE", "source-cache": "OCCURRENCE_SIGNAL_UNAVAILABLE", "failed-measurement": "OCCURRENCE_SIGNAL_UNAVAILABLE", "post-write-measurement-failure": "POST_WRITE_MEASUREMENT_FAILED", "unexpected-diff": "UNEXPECTED_DIFF", "recovery-failure": "RECOVERY_REQUIRED" };
const outcomes: Record<string, string> = { quiet: "verified", loud: "verified", "nonzero-gain": "verified", "repeated-source": "verified", "already-normalized": "no-op", silent: "skip", "no-dialogue": "skip", "too-short": "skip", "gain-limits": "skip", "peak-risk": "skip", "malformed-measurement": "rejected", "stale-preview": "rejected", "provider-mismatch": "rejected", "range-mismatch": "rejected", "revision-mismatch": "rejected", "source-cache": "rejected", "failed-measurement": "rejected", "post-write-measurement-failure": "recovered", "unexpected-diff": "recovered", "recovery-failure": "recovery-required" };
export function dialogueNativeFixture(commit = "a".repeat(40)): any {
  const policy = { targetLufs: -16, toleranceDb: 0.5, maxTruePeakDb: -1, minGainDb: -6, maxGainDb: 6, minDialogueDurationSeconds: 1 };
  const target = { projectId: "project-dialogue", sequenceId: "sequence-dialogue", occurrenceId: "occurrence-dialogue", mediaId: "media-dialogue" };
  const scenarios = Object.entries(outcomes).map(([id, outcome]) => {
    const changed = ["verified", "recovered", "recovery-required"].includes(outcome);
    const gain = id === "loud" ? -4 : changed ? 4 : 0;
    const initialGain = id === "nonzero-gain" ? 2 : 0;
    const beforeLufs = id === "silent" ? null : id === "gain-limits" ? -40 : id === "loud" ? -12 : outcome === "no-op" ? -16 : -20;
    const reference = { sourceDigest: `sha256:${h("source")}`, sourceRange: { start: 1, end: id === "too-short" ? 1.25 : 3 }, sequenceRange: { start: 0, end: id === "too-short" ? 0.25 : 2 },
      baselineDigest: h(`${id}:before`), expectedAfterDigest: h(`${id}:${changed ? "after" : "before"}`), expectedGainDb: initialGain + gain,
      untouchedDigest: h("other-occurrences"), unrelatedDigest: h("other-projects"), beforeLufs, afterLufs: -16,
      beforeTruePeakDb: id === "silent" ? null : id === "peak-risk" ? -2 : outcome === "no-op" ? -6 : -10, afterTruePeakDb: -6, toleranceDb: 0.2, reusedOccurrenceId: id === "repeated-source" ? "reused" : undefined, dialoguePresent: id !== "no-dialogue" };
    const state = (phase: string, sequence: number, gainDb: number) => ({ digest: h(`${id}:${phase}`), gainDb, sourceDigest: reference.sourceDigest,
      untouchedDigest: reference.untouchedDigest, unrelatedDigest: reference.unrelatedDigest, revision: { id: `${id}:${sequence}`, sequence, timestamp: "2026-11-15T00:00:00.000Z" } });
    const before = state("before", 1, initialGain);
    const after = changed ? state("after", 2, initialGain + gain) : structuredClone(before);
    const restored = changed ? state("before", 3, initialGain) : structuredClone(before);
    const signal = (snapshot: any, phase: string, lufs: number, truePeakDb: number) => ({
      integratedLufs: lufs, truePeakDb, silenceMs: 0, durationSeconds: 2, mediaId: target.mediaId, occurrenceId: target.occurrenceId,
      revision: snapshot.revision, sourceDigest: reference.sourceDigest, sourceRange: reference.sourceRange,
      provider: { id: "meter", provider: "ffmpeg", version: "1" }, signal: { scope: "isolated-occurrence", origin: "editor-export", effectScope: "gain-only",
        requestId: `${id}:${phase}`, projectId: target.projectId, sequenceId: target.sequenceId, canonicalDigest: snapshot.digest,
        sequenceRange: reference.sequenceRange, gainDb: snapshot.gainDb, outputDigest: `sha256:${h(`${id}:${phase}:signal`)}`,
        sampleRate: 48000, sampleCount: 96000, meterVersion: "ffmpeg version test", exporter: { id: "native-export", provider: "native", version: "1" } } });
    const hasToken = outcome !== "rejected" || id === "stale-preview";
    return { id, outcome, target, policy, reference, before, after, restored, writeCount: changed ? 1 : 0,
      previewDigest: before.digest, executedTokenDigest: hasToken ? h(`${id}:preview`) : undefined,
      approval: { candidateCommit: commit, ...target, baselineDigest: before.digest, revisionId: before.revision.id,
        referenceDigest: h(JSON.stringify(reference)), gainDb: reference.expectedGainDb, policy, previewTokenDigest: hasToken ? h(`${id}:preview`) : undefined, requestDigest: h(JSON.stringify({ target, policy, referenceDigest: h(JSON.stringify(reference)), revision: before.revision })) },
      ...(reasons[id] ? { reason: reasons[id] } : {}),
      ...(["verified", "no-op"].includes(outcome) ? { input: signal(before, "before", beforeLufs!, reference.beforeTruePeakDb!), output: signal(after, "after", -16, -6) } : {}),
      ...(["recovered", "recovery-required"].includes(outcome) ? { recovery: { status: outcome === "recovered" ? "RESTORED" : "RECOVERY_REQUIRED", writesBlocked: true, restorationOperationId: `${id}:restore` } } : {}) };
  });
  return { schemaVersion: 2, evidenceType: "headed-native-dialogue-normalization", passed: true, recordedAt: "2026-11-15T00:00:00.000Z",
    environment: { framekitVersion: "0.2.4", finalCutVersion: "test", gitCommit: commit, nodeVersion: "22", platform: "darwin", architecture: "arm64", osVersion: "Darwin" },
    editor: { name: "Final Cut Pro", version: "test", backend: "final-cut-live" },
    capabilities: { editor: { canonicalTimelineMode: "canonical-write", timelineSnapshotRead: true, timelineWrite: true, readAfterWrite: true, rollback: true, singleOperationTransactions: true, semanticOperations: { "set-gain": true } }, analyzers: { audioLoudness: true } },
    project: { id: target.projectId, name: "Disposable Dialogue", sequenceId: target.sequenceId, occurrenceId: target.occurrenceId },
    target: { project: "Disposable Dialogue", ...target }, revisions: { before: "quiet:1", after: "quiet:2", restored: "quiet:3" }, verification: { execute: true, undo: true },
    acceptance: { candidateCommit: commit, components: ["package", "plugin", "workflow-extension", "audio-exporter", "audio-meter"].map(name => ({ name, version: "1", expectedCommit: commit, observedCommit: commit, artifactDigest: h(name),
      ...(name === "audio-exporter" ? { descriptor: { id: "native-export", provider: "native", version: "1" } } : {}),
      ...(name === "audio-meter" ? { descriptor: { id: "meter", provider: "ffmpeg", version: "1" }, meterVersion: "ffmpeg version test" } : {}) })), scenarios } };
}
