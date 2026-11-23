export const headlessResults = [
  "candidate-mismatch", "candidate-changed", "render-contract-passed", "render-contract-failed", "preflight-error",
  "artifact-digest-mismatch", "artifact-unsafe", "artifact-changed", "artifact-check-failed", "publisher-fixture-mismatch",
  "source-digest-mismatch", "source-unsafe", "source-changed", "source-check-failed",
] as const;
export type HeadlessResult = typeof headlessResults[number];

function sourceFailure(error: unknown): HeadlessResult {
  if (error instanceof Error && error.message === "QA_SOURCE_DIGEST_MISMATCH") return "source-digest-mismatch";
  if (error instanceof Error && error.message === "QA_SOURCE_UNSAFE") return "source-unsafe";
  if (error instanceof Error && error.message === "QA_SOURCE_CHANGED") return "source-changed";
  return "source-check-failed";
}

/** Run only supplied headless checks; this function never authorizes or dispatches native work. */
export async function runHeadlessQaChecks(checks: {
  candidateMatches: () => Promise<boolean>;
  verifyArtifact?: () => Promise<void>;
  verifySourcesAfter?: () => Promise<void>;
  runRenderContract: () => Promise<void>;
}): Promise<HeadlessResult> {
  try {
    if (!await checks.candidateMatches()) return "candidate-mismatch";
    if (checks.verifyArtifact) {
      try { await checks.verifyArtifact(); }
      catch (error) {
        if (error instanceof Error && error.message === "QA_ARTIFACT_DIGEST_MISMATCH") return "artifact-digest-mismatch";
        if (error instanceof Error && error.message === "QA_ARTIFACT_UNSAFE") return "artifact-unsafe";
        if (error instanceof Error && error.message === "QA_ARTIFACT_CHANGED") return "artifact-changed";
        if (error instanceof Error && error.message === "QA_PUBLISH_FIXTURE_MISMATCH") return "publisher-fixture-mismatch";
        if (error instanceof Error && error.message.startsWith("QA_SOURCE_")) return sourceFailure(error);
        return "artifact-check-failed";
      }
    }
    let result: HeadlessResult;
    try { await checks.runRenderContract(); result = "render-contract-passed"; }
    catch { result = "render-contract-failed"; }
    if (result === "render-contract-passed" && checks.verifySourcesAfter) {
      try { await checks.verifySourcesAfter(); } catch (error) { result = sourceFailure(error); }
    }
    return await checks.candidateMatches() ? result : "candidate-changed";
  } catch { return "preflight-error"; }
}
