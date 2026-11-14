import { createHash } from "node:crypto";

// Synthetic validator inputs only. Never write these as native run receipts.
export const fillerScenarios = ["reviewed-removal", "protected-speech", "uncertain-candidates", "repeated-source", "fractional-multiple-cuts",
  "no-candidates", "invalid-selection", "stale-preview", "expired-preview", "reused-token", "missing-vad", "verification-recovery"];
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function fillerNativeEvidence() {
  const commit = "d".repeat(40);
  const target = { projectId: "project-filler", sequenceId: "sequence-filler", occurrenceId: "occurrence-filler" };
  const revision = (id: string, sequence: number) => ({ id, sequence, timestamp: `2026-11-15T00:00:0${sequence}.000Z` });
  return {
    schemaVersion: 2, evidenceType: "headed-native-filler-removal", passed: true, recordedAt: "2026-11-15T00:00:09.000Z",
    environment: { framekitVersion: "0.2.4", finalCutVersion: "test-only", gitCommit: commit, nodeVersion: "test", platform: "darwin", architecture: "arm64", osVersion: "test" },
    editor: { name: "Final Cut Pro", version: "test-only", backend: "final-cut-live" },
    capabilities: { editor: { canonicalTimelineMode: "canonical-write", timelineSnapshotRead: true, timelineWrite: true,
      compositeTransactions: true, readAfterWrite: true, rollback: true, semanticOperations: { "ripple-delete": true } },
      analyzers: { speechTranscribe: true, speechVad: true } },
    project: { id: target.projectId, name: "Disposable Filler", sequenceId: target.sequenceId, occurrenceId: target.occurrenceId },
    target: { ...target, project: "Disposable Filler" },
    selection: { start: 0, end: 4 },
    removal: { status: "VERIFIED", candidateCount: 1, operationCount: 1, removedDurationSeconds: 0.5, affectedRangeCount: 1,
      continuityVerified: true, beforeRevision: revision("before", 1), afterRevision: revision("after", 2) },
    restoration: { status: "VERIFIED", restored: true, restoredRevision: revision("restored", 3), beforeDigest: hash("before"), restoredDigest: hash("before") },
    revisions: { before: "before", after: "after", restored: "restored" }, verification: { execute: true, undo: true },
    toolResults: [{ name: "skill.preview", status: "passed" }, { name: "skill.preview", status: "passed" },
      { name: "skill.execute", status: "VERIFIED" }, { name: "edit.undo", status: "passed" }],
    acceptance: {
      candidateCommit: commit,
      components: ["package", "plugin", "workflow-extension", "speech-provider"].map(name => ({ name, version: "1", expectedCommit: commit, observedCommit: commit, artifactDigest: hash(name) })),
      scenarios: fillerScenarios.map(id => {
        const changes = ["reviewed-removal", "protected-speech", "repeated-source", "fractional-multiple-cuts", "verification-recovery"].includes(id);
        const cuts = changes ? [{ candidateId: "candidate", occurrenceId: target.occurrenceId, startFrame: 24, endFrame: 36 }] : [];
        const before = { revision: revision(`${id}-before`, 1), digest: hash(`${id}-before`) };
        const after = changes ? { revision: revision(`${id}-after`, 2), digest: hash(`${id}-after`) } : structuredClone(before);
        const restored = changes ? { revision: revision(`${id}-restored`, 3), digest: before.digest } : structuredClone(before);
        const reference = { frameDuration: { value: "1001", timescale: "24000" }, expectedCuts: cuts,
          protectedRanges: [{ occurrenceId: target.occurrenceId, startFrame: 0, endFrame: 20 }],
          expectedAfterDigest: after.digest, expectedContentDigest: hash("known public reference transcript") };
        const source = [{ mediaId: "media-filler", digest: hash("source bytes") }];
        return { id, target, outcome: id === "verification-recovery" ? "recovered" : changes ? "verified" : id === "no-candidates" ? "no-op" : "rejected",
          authorization: { candidateCommit: commit, ...target, beforeRevisionId: before.revision.id, referenceDigest: hash(JSON.stringify(reference)),
            operations: changes ? ["preview", "execute", "verify", "undo"] : ["preview", "verify"] },
          reference, before, after, restored, sourceIntegrity: { before: source, after: source, restored: source },
          review: { suggestedCandidateIds: changes ? ["candidate"] : [], approvedCandidateIds: changes ? ["candidate"] : [],
            selectedCandidateIds: changes ? ["candidate"] : [], approvedCuts: cuts, executedCuts: cuts,
            firstPreviewDigest: before.digest, selectedPreviewDigest: before.digest,
            approvedPreviewDigest: hash(`${id}-approved-token`), executedPreviewDigest: hash(`${id}-approved-token`) },
          ...(changes ? { editedSpeech: { scope: "edited-timeline-output", ...target, revisionId: after.revision.id, canonicalDigest: after.digest,
            outputDigest: hash(`${id}-exported audio`), provider: { id: "real-provider-contract", version: "1" },
            observedContentDigest: reference.expectedContentDigest } } : {}),
          ...(id === "verification-recovery" ? { failure: { code: "CONTINUITY_FAILED", restorationVerified: true } } : {}),
          ...(!changes && id !== "no-candidates" ? { rejectionCode: "REJECTED_AS_EXPECTED" } : {}),
        };
      }),
    },
  };
}
