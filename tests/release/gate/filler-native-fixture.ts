import { createHash } from "node:crypto";

// Synthetic validator inputs only. Never write these as native run receipts.
export const fillerScenarios = ["reviewed-removal", "protected-speech", "uncertain-candidates", "repeated-source", "fractional-multiple-cuts",
  "no-candidates", "invalid-selection", "stale-preview", "expired-preview", "reused-token", "missing-vad", "verification-recovery"];
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function fillerNativeEvidence() {
  const commit = "d".repeat(40);
  const target = { projectId: "project-filler", sequenceId: "sequence-filler", occurrenceId: "occurrence-filler" };
  const revision = (id: string, sequence: number) => ({ id, sequence, timestamp: `2026-11-15T00:00:0${sequence}.000Z` });
  const result = {
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
        if (id === "fractional-multiple-cuts") cuts.push({ candidateId: "candidate-2", occurrenceId: target.occurrenceId, startFrame: 48, endFrame: 60 });
        const candidateIds = cuts.map(cut => cut.candidateId);
        const before = { revision: revision(`${id}-before`, 1), digest: hash(`${id}-before`), semanticDigest: hash(`${id}-source-ranges-before`) };
        const after = changes ? { revision: revision(`${id}-after`, 2), digest: hash(`${id}-after`), semanticDigest: hash(`${id}-source-ranges-after`) } : structuredClone(before);
        const restored = changes ? { revision: revision(`${id}-restored`, 3), digest: before.digest, semanticDigest: before.semanticDigest } : structuredClone(before);
        const reference = { frameDuration: { value: "1001", timescale: "24000" }, expectedCuts: cuts,
          protectedRanges: [{ occurrenceId: target.occurrenceId, startFrame: 0, endFrame: 20 }],
          expectedAfterDigest: after.semanticDigest, expectedContentDigest: hash("known public reference transcript"),
          ...(id === "repeated-source" ? { reusedSource: { mediaId: "media-filler", sourceDigest: hash("source bytes"),
            selectedOccurrenceId: target.occurrenceId, untouchedOccurrenceId: "duplicate-occurrence", expectedUntouchedDigest: hash("duplicate occurrence state") } } : {}) };
        const source = [{ mediaId: "media-filler", digest: hash("source bytes") }];
        const rejectionCodes: Record<string, string> = { "invalid-selection": "CANDIDATE_NOT_FOUND", "stale-preview": "STALE_CONTEXT", "expired-preview": "SKILL_PREVIEW_TOKEN_EXPIRED", "reused-token": "SKILL_PREVIEW_TOKEN_INVALID", "missing-vad": "SKILL_REQUIREMENTS_UNMET" };
        return { id, target, outcome: id === "verification-recovery" ? "recovered" : changes ? "verified" : ["no-candidates", "uncertain-candidates"].includes(id) ? "no-op" : "rejected",
          approval: { candidateCommit: commit, ...target, beforeRevisionId: before.revision.id, referenceDigest: hash(JSON.stringify(reference)),
            operations: ["preview", "execute", "verify", "undo"] },
          reference, before, after, restored, sourceIntegrity: { before: source, after: source, restored: source },
          ...(reference.reusedSource ? { reusedSourceReadback: { mediaId: "media-filler", sourceDigest: hash("source bytes"),
            selectedOccurrenceId: target.occurrenceId, untouchedOccurrenceId: "duplicate-occurrence", beforeDigest: hash("duplicate occurrence state"),
            afterDigest: hash("duplicate occurrence state"), restoredDigest: hash("duplicate occurrence state") } } : {}),
          review: { suggestedCandidateIds: id === "uncertain-candidates" ? ["uncertain-candidate"] : candidateIds, approvedCandidateIds: candidateIds,
            selectedCandidateIds: candidateIds, approvedCuts: cuts, executedCuts: cuts,
            firstPreviewDigest: before.digest, selectedPreviewDigest: before.digest,
            approvedPreviewDigest: hash(`${id}-approved-token`), executedPreviewDigest: hash(`${id}-approved-token`) },
          ...(changes ? { editedSpeech: { scope: "edited-timeline-output", ...target, revisionId: after.revision.id, canonicalDigest: after.digest,
            outputDigest: hash(`${id}-exported audio`), provider: { id: "real-provider-contract", version: "1" },
            observedContentDigest: id === "verification-recovery" ? hash("deliberate speech continuity failure") : reference.expectedContentDigest } } : {}),
          ...(id === "verification-recovery" ? { failure: { code: "CONTINUITY_FAILED", restorationVerified: true } } : {}),
          ...(rejectionCodes[id] ? { rejectionCode: rejectionCodes[id] } : {}),
        };
      }),
    },
  };
  const reviewed = result.acceptance.scenarios[0]!;
  result.removal.beforeRevision = reviewed.before.revision;
  result.removal.afterRevision = reviewed.after.revision;
  result.removal.removedDurationSeconds = 12 * 1001 / 24000;
  result.restoration.restoredRevision = reviewed.restored.revision;
  result.restoration.beforeDigest = reviewed.before.digest;
  result.restoration.restoredDigest = reviewed.restored.digest;
  result.revisions = { before: reviewed.before.revision.id, after: reviewed.after.revision.id, restored: reviewed.restored.revision.id };
  return result;
}
