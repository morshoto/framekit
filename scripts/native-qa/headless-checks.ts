export const headlessResults = [
  "candidate-mismatch", "candidate-changed", "render-contract-passed", "render-contract-failed", "preflight-error",
  "artifact-digest-mismatch", "artifact-unsafe", "artifact-changed", "artifact-check-failed",
] as const;
export type HeadlessResult = typeof headlessResults[number];

/** Run only supplied headless checks; this function never authorizes or dispatches native work. */
export async function runHeadlessQaChecks(checks: {
  candidateMatches: () => Promise<boolean>;
  verifyArtifact?: () => Promise<void>;
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
        return "artifact-check-failed";
      }
    }
    let result: HeadlessResult;
    try { await checks.runRenderContract(); result = "render-contract-passed"; }
    catch { result = "render-contract-failed"; }
    return await checks.candidateMatches() ? result : "candidate-changed";
  } catch { return "preflight-error"; }
}
