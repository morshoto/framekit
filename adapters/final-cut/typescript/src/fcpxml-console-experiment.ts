export type FinalCutFcpxmlConsoleState = "unlocked" | "locked" | "unknown";
export type FinalCutFcpxmlProcessState = "running" | "not-running";
export type FinalCutFcpxmlFrontmostState = "final-cut" | "other" | "unknown";
export type FinalCutFcpxmlLibraryEvidence = "filesystem" | "native" | "none";

export interface FinalCutFcpxmlExperimentObservation {
  artifact: {
    format: "fcpxml";
    version: string;
    digest: string;
    valid: boolean;
  };
  process: FinalCutFcpxmlProcessState;
  frontmost: FinalCutFcpxmlFrontmostState;
  console: {
    state: FinalCutFcpxmlConsoleState;
    source: string;
    retryable: boolean;
  };
  library: {
    state: "observed" | "not-inspected" | "unavailable";
    evidence: FinalCutFcpxmlLibraryEvidence;
  };
  log: {
    state: "observed" | "not-collected" | "unavailable";
    lineCount: number;
  };
}

export type FinalCutFcpxmlExperimentStatus = "artifact-only" | "headed-preflight-ready" | "blocked";
export type FinalCutFcpxmlCapability = "verified" | "preflight-only" | "blocked" | "unavailable";

export interface FinalCutFcpxmlExperimentResult {
  schemaVersion: 1;
  status: FinalCutFcpxmlExperimentStatus;
  observation: FinalCutFcpxmlExperimentObservation;
  capabilities: {
    artifactRead: FinalCutFcpxmlCapability;
    headedImport: FinalCutFcpxmlCapability;
    targetBoundReadback: FinalCutFcpxmlCapability;
  };
  blockers: Array<{
    code: string;
    retryable: boolean;
    message: string;
  }>;
  mutationAttempted: false;
  nativeImportVerified: false;
  safeToOverwrite: false;
}

/**
 * Classifies evidence collected around the FCPXML programmatic/artifact path.
 * This function never authorizes a write: a headed result is preflight only,
 * and target-bound import readback remains unavailable until independently
 * proven by a native provider.
 */
export function classifyFinalCutFcpxmlExperiment(
  observation: FinalCutFcpxmlExperimentObservation,
): FinalCutFcpxmlExperimentResult {
  validateArtifact(observation.artifact);
  if (!observation.console.source.trim()) throw new Error("FCPXML_EXPERIMENT_INVALID: console source is required");
  if (!Number.isInteger(observation.log.lineCount) || observation.log.lineCount < 0) {
    throw new Error("FCPXML_EXPERIMENT_INVALID: log lineCount must be a non-negative integer");
  }

  const base = {
    schemaVersion: 1 as const,
    observation: structuredClone(observation),
    capabilities: {
      artifactRead: "verified" as const,
      targetBoundReadback: "unavailable" as const,
    },
    mutationAttempted: false as const,
    nativeImportVerified: false as const,
    safeToOverwrite: false as const,
  };
  if (observation.console.state === "locked") {
    return {
      ...base,
      status: "blocked",
      capabilities: { ...base.capabilities, headedImport: "blocked" },
      blockers: [{
        code: "FINAL_CUT_NATIVE_CONSOLE_LOCKED",
        retryable: observation.console.retryable,
        message: "The macOS console is locked; no headed FCPXML import was attempted",
      }],
    };
  }
  if (observation.console.state === "unknown") {
    return {
      ...base,
      status: "blocked",
      capabilities: { ...base.capabilities, headedImport: "blocked" },
      blockers: [{
        code: "FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN",
        retryable: observation.console.retryable,
        message: "macOS did not expose one consistent supported console lock state",
      }],
    };
  }
  if (observation.process !== "running") {
    return artifactOnly(base, "FINAL_CUT_NOT_RUNNING", true, "Final Cut Pro is not running; only the FCPXML artifact was inspected");
  }
  if (observation.frontmost !== "final-cut") {
    return artifactOnly(base, "FINAL_CUT_NOT_FRONTMOST", true, "Final Cut Pro is not frontmost; only the FCPXML artifact was inspected");
  }
  return {
    ...base,
    status: "headed-preflight-ready",
    capabilities: { ...base.capabilities, headedImport: "preflight-only" },
    blockers: [],
  };
}

function artifactOnly(
  base: Omit<FinalCutFcpxmlExperimentResult, "status" | "blockers" | "capabilities"> & { capabilities: { artifactRead: "verified"; targetBoundReadback: "unavailable" } },
  code: string,
  retryable: boolean,
  message: string,
): FinalCutFcpxmlExperimentResult {
  return {
    ...base,
    status: "artifact-only",
    capabilities: { ...base.capabilities, headedImport: "blocked" },
    blockers: [{ code, retryable, message }],
  };
}

function validateArtifact(artifact: FinalCutFcpxmlExperimentObservation["artifact"]): void {
  if (artifact.format !== "fcpxml" || !artifact.valid || artifact.version !== "1.11" || !/^[a-f0-9]{64}$/i.test(artifact.digest)) {
    throw new Error("FCPXML_ARTIFACT_INVALID: experiment requires a valid FCPXML 1.11 artifact and SHA-256 digest");
  }
}
