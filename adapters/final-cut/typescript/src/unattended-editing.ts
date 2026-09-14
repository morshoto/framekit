import type {
  ContextRevision,
  EditingSessionState,
  TimelineIr,
  TimelineIrEditOperation,
  TimelineReconciliationResult,
} from "@framekit/runtime";
import { EditingSession } from "@framekit/runtime";
import {
  compareFinalCutSqliteObservations,
  type FinalCutSqliteObservation,
} from "./sqlite-inspection.js";
import {
  compileTimelineIrToFcpxml,
  type TimelineIrToFcpxmlResult,
  type TimelineIrToFcpxmlTarget,
} from "./timeline-ir-fcpxml.js";
import {
  classifyFinalCutFcpxmlExperiment,
  type FinalCutFcpxmlExperimentResult,
  type FinalCutFcpxmlExperimentObservation,
} from "./fcpxml-console-experiment.js";

export type UnattendedEditingEnvironment = Omit<FinalCutFcpxmlExperimentObservation, "artifact">;

export interface UnattendedEditingWorkflowOptions {
  base: TimelineIr;
  providerState: TimelineIr;
  operations: TimelineIrEditOperation[];
  target: TimelineIrToFcpxmlTarget;
  environment: UnattendedEditingEnvironment;
  sqlite?: {
    before?: FinalCutSqliteObservation;
    after?: FinalCutSqliteObservation;
  };
}

export type UnattendedEditingStatus = "artifact-verified" | "artifact-verified-native-blocked" | "conflicted" | "stale";

export type UnattendedSqliteEvidence =
  | { status: "not-provided"; canonical: false }
  | {
      status: "observed";
      canonical: false;
      digest: string;
      coverageComplete: false;
    }
  | {
      status: "unchanged" | "changed";
      canonical: false;
      previousDigest: string;
      currentDigest: string;
      reasons: string[];
    };

export interface UnattendedEditingWorkflowResult {
  status: UnattendedEditingStatus;
  session: {
    state: EditingSessionState;
    base: TimelineIr;
    desired: TimelineIr;
    serialized: string;
  };
  reconciliation?: TimelineReconciliationResult;
  sqlite: UnattendedSqliteEvidence;
  artifact?: TimelineIrToFcpxmlResult;
  experiment?: FinalCutFcpxmlExperimentResult;
  mutationAttempted: false;
  overwritten: false;
}

/**
 * Runs the safe, unattended portion of an edit. It can read a storage
 * observation, rebase a session against provider state, and produce a new
 * FCPXML artifact. It never calls Final Cut, imports an artifact, or writes a
 * destination file.
 */
export function runUnattendedEditingWorkflow(
  options: UnattendedEditingWorkflowOptions,
): UnattendedEditingWorkflowResult {
  const session = EditingSession.create({ base: options.base, provider: { id: "final-cut" } });
  session.apply(options.operations);
  const sqlite = sqliteEvidence(options.sqlite);
  if (sqlite.status === "changed" && sameRevision(options.base.revision, options.providerState.revision)) {
    session.markPossiblyStale();
    return result(session, "stale", sqlite);
  }
  let reconciliation: TimelineReconciliationResult | undefined;
  if (!sameRevision(options.base.revision, options.providerState.revision)) {
    reconciliation = session.reconcile(options.providerState);
    if (reconciliation.status === "conflicted") return result(session, "conflicted", sqlite, reconciliation);
  }
  session.assertMaterializationReady(options.providerState.revision);
  const artifact = compileTimelineIrToFcpxml(session.desired(), { target: options.target });
  const experiment = classifyFinalCutFcpxmlExperiment({
    ...options.environment,
    artifact: { format: "fcpxml", version: artifact.version, digest: artifact.digest, valid: true },
  });
  return {
    ...result(session, experiment.status === "headed-preflight-ready" ? "artifact-verified" : "artifact-verified-native-blocked", sqlite, reconciliation),
    artifact,
    experiment,
  };
}

function result(
  session: EditingSession,
  status: UnattendedEditingStatus,
  sqlite: UnattendedSqliteEvidence,
  reconciliation?: TimelineReconciliationResult,
): UnattendedEditingWorkflowResult {
  return {
    status,
    session: {
      state: session.state(),
      base: session.base(),
      desired: session.desired(),
      serialized: session.serialize(),
    },
    ...(reconciliation ? { reconciliation } : {}),
    sqlite,
    mutationAttempted: false,
    overwritten: false,
  };
}

function sqliteEvidence(input: UnattendedEditingWorkflowOptions["sqlite"]): UnattendedSqliteEvidence {
  if (!input?.before && !input?.after) return { status: "not-provided", canonical: false };
  if (!input?.before) {
    return { status: "observed", canonical: false, digest: input.after!.digest, coverageComplete: input.after!.coverage.complete };
  }
  if (!input.after) {
    return { status: "observed", canonical: false, digest: input.before.digest, coverageComplete: input.before.coverage.complete };
  }
  const comparison = compareFinalCutSqliteObservations(input.before, input.after);
  return { ...comparison, canonical: false };
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
