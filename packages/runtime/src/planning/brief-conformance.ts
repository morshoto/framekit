import { isDeepStrictEqual } from "node:util";
import type { ContextRevision } from "../domain/primitives.js";
import type { FramekitRenderAndVerifyResult, FramekitRenderArtifactVerifier } from "../render/render-and-verify.js";
import { assertBriefBinding } from "./creative-brief.js";
import type { AcceptedCreativeBrief, CreativeBrief } from "./creative-brief.js";
import type { EditDecisionPlan } from "./edit-decision-plan.js";

/** Supplied execution evidence must be authenticated independently by the caller. */
export interface BriefExecutionObservation {
  status: "verified" | "failed" | "unavailable";
  planDigest: string;
  baseRevision: ContextRevision;
  finalRevision: ContextRevision;
}
/** Artifact metadata must come from an independent verifier; this function does not inspect files. */
export interface BriefArtifactObservation {
  status: "passed" | "failed" | "unavailable";
  target: { projectId: string; sequenceId: string };
  revision: ContextRevision;
  fileDigest: string;
  durationSeconds: number;
  width: number;
  height: number;
}
export interface BriefArtifactCheck {
  name: "duration" | "aspect-ratio" | "source-coverage" | "music" | "captions";
  status: "passed" | "failed" | "unavailable";
  detail: string;
}
export interface BriefArtifactAssessment {
  status: "incomplete";
  nativeAcceptance: "unavailable";
  /** Caller-supplied binding; independently authenticate before relying on it. */
  binding?: { planDigest: string; artifactDigest: string; target: BriefArtifactObservation["target"]; finalRevision: ContextRevision };
  checks: BriefArtifactCheck[];
  reviewPrompts: string[];
}

/** Inspect a previously verified headless result; callers must reverify the file before use. */
function briefArtifactObservationFromRender(result: FramekitRenderAndVerifyResult): BriefArtifactObservation | undefined {
  try {
    const { plan, render, verification } = result;
    if (result.status !== "passed" || !plan || !render || verification?.status !== "passed" || !verification.artifact
      || render.status !== "rendered" || render.contractVersion !== plan.contractVersion
      || render.planDigest !== plan.planDigest || !isDeepStrictEqual(render.target, plan.target)
      || !isDeepStrictEqual(render.projectRevision, plan.projectRevision) || !isDeepStrictEqual(render.renderer, plan.renderer)
      || render.output.path !== plan.parameters.outputPath || render.output.format !== plan.parameters.format
      || render.verificationRequired !== true || verification.artifact.path !== render.output.path
      || !Array.isArray(verification.checks) || verification.checks.some((check) => check.passed !== true)) return undefined;
    const required = ["output-exists", "output-digest", "output-stability", "playable", "format", "dimensions", "frame-rate", "duration"];
    if (required.some((name) => verification.checks.filter((check) => check.name === name && check.passed).length !== 1)) return undefined;
    const artifact = verification.artifact;
    const digestCheck = verification.checks.find((check) => check.name === "output-digest");
    if (digestCheck?.observed !== artifact.fileDigest || !/^[a-f0-9]{64}$/.test(artifact.fileDigest)
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
      || !Number.isFinite(artifact.durationSeconds) || artifact.durationSeconds <= 0
      || !Number.isSafeInteger(artifact.width) || artifact.width <= 0 || !Number.isSafeInteger(artifact.height) || artifact.height <= 0
      || artifact.width !== plan.parameters.width || artifact.height !== plan.parameters.height) return undefined;
    return { status: "passed", target: structuredClone(plan.target), revision: structuredClone(plan.projectRevision),
      fileDigest: artifact.fileDigest, durationSeconds: artifact.durationSeconds, width: artifact.width, height: artifact.height };
  } catch { return undefined; }
}

/** Recheck artifact bytes and metadata at the time of this call; this is not continuous fencing. */
export async function reverifyBriefArtifactObservation(
  result: FramekitRenderAndVerifyResult, verifier: FramekitRenderArtifactVerifier,
): Promise<BriefArtifactObservation | undefined> {
  try {
    const bound = structuredClone(result);
    const original = briefArtifactObservationFromRender(bound);
    if (!original || !bound.plan || !bound.render || typeof verifier?.verify !== "function") return undefined;
    const verification = await verifier.verify(structuredClone(bound.plan), structuredClone(bound.render));
    const current = briefArtifactObservationFromRender({ ...bound, verification });
    return current && isDeepStrictEqual(original, current) ? current : undefined;
  } catch { return undefined; }
}

function validRevision(value: ContextRevision | undefined): value is ContextRevision {
  return !!value && typeof value.id === "string" && value.id.trim().length > 0
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && typeof value.timestamp === "string" && value.timestamp.trim().length > 0;
}

/** Compare supplied observations only. No authenticated native receipt or file read is implied. */
export function assessBriefArtifact(
  brief: CreativeBrief, accepted: AcceptedCreativeBrief, plan: EditDecisionPlan,
  execution: BriefExecutionObservation, artifact: BriefArtifactObservation,
): BriefArtifactAssessment {
  const checks: BriefArtifactCheck[] = [];
  let bound = false;
  try {
    assertBriefBinding(accepted, brief);
    bound = isDeepStrictEqual(plan.acceptedBrief, accepted)
      && validRevision(plan.revision) && validRevision(execution.baseRevision)
      && validRevision(execution.finalRevision) && validRevision(artifact.revision)
      && execution.status === "verified" && execution.planDigest === plan.planDigest
      && isDeepStrictEqual(execution.baseRevision, plan.revision)
      && artifact.status === "passed" && isDeepStrictEqual(artifact.revision, execution.finalRevision)
      && artifact.target.projectId === plan.projectId && artifact.target.sequenceId === plan.timelineId
      && /^(?:sha256:)?[a-f0-9]{64}$/.test(artifact.fileDigest)
      && Number.isFinite(artifact.durationSeconds) && artifact.durationSeconds > 0
      && Number.isSafeInteger(artifact.width) && artifact.width > 0
      && Number.isSafeInteger(artifact.height) && artifact.height > 0;
  } catch { bound = false; }
  if (!bound) {
    checks.push({ name: "duration", status: "unavailable", detail: "Execution or verified artifact is missing, invalid or not bound to this plan and target." });
    checks.push({ name: "aspect-ratio", status: "unavailable", detail: "Execution or verified artifact is missing, invalid or not bound to this plan and target." });
  } else {
    const within = artifact.durationSeconds >= brief.durationSeconds.min && artifact.durationSeconds <= brief.durationSeconds.max;
    checks.push({ name: "duration", status: within ? "passed" : "failed", detail: `Observed duration: ${artifact.durationSeconds} seconds.` });
    const ratio = /^(\d+):(\d+)$/.exec(brief.aspectRatio);
    if (!ratio || !Number.isSafeInteger(Number(ratio[1])) || !Number.isSafeInteger(Number(ratio[2])) || Number(ratio[1]) <= 0 || Number(ratio[2]) <= 0) {
      checks.push({ name: "aspect-ratio", status: "unavailable", detail: "The approved aspect ratio cannot be compared." });
    } else {
      const matches = BigInt(artifact.width) * BigInt(ratio[2]!) === BigInt(artifact.height) * BigInt(ratio[1]!);
      checks.push({ name: "aspect-ratio", status: matches ? "passed" : "failed", detail: `Observed dimensions: ${artifact.width} × ${artifact.height}.` });
    }
  }
  checks.push({ name: "source-coverage", status: "unavailable", detail: "Independent source and occurrence coverage has not been established." });
  checks.push({ name: "music", status: "unavailable", detail: "Music placement and final audible output have not been established." });
  checks.push({ name: "captions", status: "unavailable", detail: "Editable caption and output evidence have not been established." });
  return { status: "incomplete", nativeAcceptance: "unavailable", checks,
    ...(bound ? { binding: { planDigest: plan.planDigest, artifactDigest: artifact.fileDigest,
      target: structuredClone(artifact.target), finalRevision: structuredClone(artifact.revision) } } : {}),
    reviewPrompts: [...(brief?.reviewPrompts ?? [])] };
}
