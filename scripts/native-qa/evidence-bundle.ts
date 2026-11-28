import { inspectRun } from "./run-store.js";
import { readQaEvidence } from "./supervisor.js";
import { readQaArtifactEvidence } from "./artifact-evidence.js";
import { readQaPublisherFixtureEvidence } from "./publisher-fixture-evidence.js";
import { readQaPublisherSourceEvidence } from "./publisher-source-evidence.js";
import { readQaPublisherStages } from "./publisher-stages.js";
import { readQaPluginEvidence } from "./plugin-evidence.js";
import { readQaPublisherObservations } from "./publisher-observation.js";
import { readQaPublisherVerificationClaim } from "./publisher-supervision.js";
import { readQaPublisherSimulation } from "./publisher-simulation.js";

/** Return a bounded observation of persisted evidence, never a native outcome or authorization. */
export async function readQaEvidenceBundle(root: string, qaRunId: string) {
  const collect = async () => {
    const run = await inspectRun(root, qaRunId);
    const [headless, artifact, publisherFixture, publisherSources, publisherStages, plugin, publisherObservations, publisherVerification, publisherSimulation] = await Promise.all([
      readQaEvidence(root, qaRunId), readQaArtifactEvidence(root, qaRunId),
      readQaPublisherFixtureEvidence(root, qaRunId), readQaPublisherSourceEvidence(root, qaRunId),
      readQaPublisherStages(root, qaRunId), readQaPluginEvidence(root, qaRunId), readQaPublisherObservations(root, qaRunId), readQaPublisherVerificationClaim(root, qaRunId),
      run.headlessProfile === "publisher-simulation-v1" ? readQaPublisherSimulation(root, qaRunId) : null,
    ]);
    if (headless.dispatch !== run.dispatch || publisherStages.dispatch !== run.dispatch) throw new Error("QA_EVIDENCE_CHANGED");
    return { run, headless, artifact, publisherFixture, publisherSources, publisherStages, plugin, publisherObservations, publisherVerification, publisherSimulation };
  };
  const first = await collect();
  const second = await collect();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("QA_EVIDENCE_CHANGED");
  return { ...second, dispatch: second.run.dispatch, verdict: "BLOCKED" as const,
    scope: "persisted-observation" as const, nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
}
