import {
  createFramekitRenderPlan,
  type FramekitRenderCapabilityReport,
  type FramekitRenderPlan,
  type FramekitRenderProvider,
  type FramekitRenderProviderResult,
  type FramekitRenderRequest,
} from "./render-contract.js";
import type { RationalTime } from "../domain/primitives.js";

export type FramekitRenderVerificationStatus = "passed" | "failed" | "unavailable";

export interface FramekitRenderArtifactStream {
  kind: "video" | "audio";
  codec?: string;
  width?: number;
  height?: number;
  frameRate?: RationalTime;
  sampleRate?: number;
  channels?: number;
}

export interface FramekitRenderArtifactMetadata {
  path: string;
  format: string;
  sizeBytes: number;
  fileDigest: string;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: RationalTime;
  streams: FramekitRenderArtifactStream[];
}

export interface FramekitRenderVerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
  expected?: unknown;
  observed?: unknown;
}

export interface FramekitRenderVerificationResult {
  status: FramekitRenderVerificationStatus;
  checks: FramekitRenderVerificationCheck[];
  artifact?: FramekitRenderArtifactMetadata;
  error?: { code: string; message: string };
}

export interface FramekitRenderSemanticAssertionContext {
  plan: FramekitRenderPlan;
  result: FramekitRenderProviderResult;
  artifact: FramekitRenderArtifactMetadata;
}

export interface FramekitRenderSemanticAssertion {
  name: string;
  verify(context: FramekitRenderSemanticAssertionContext):
    | FramekitRenderVerificationCheck
    | boolean
    | Promise<FramekitRenderVerificationCheck | boolean>;
}

export interface FramekitRenderAndVerifyOptions {
  capabilities?: FramekitRenderCapabilityReport;
  semanticAssertions?: FramekitRenderSemanticAssertion[];
  isUnavailable?: (error: unknown) => boolean;
}

export interface FramekitRenderAndVerifyResult {
  status: FramekitRenderVerificationStatus;
  plan?: FramekitRenderPlan;
  render?: FramekitRenderProviderResult;
  verification?: FramekitRenderVerificationResult;
  error?: { code: string; message: string };
}

export interface FramekitRenderArtifactVerifier {
  verify(
    plan: FramekitRenderPlan,
    result: FramekitRenderProviderResult,
  ): Promise<FramekitRenderVerificationResult>;
}

/**
 * Owns the closed loop: immutable plan, provider render, then an independent
 * artifact verification gate. Provider success alone never yields `passed`.
 */
export async function renderAndVerifyFramekitProject(
  request: FramekitRenderRequest,
  provider: FramekitRenderProvider,
  verifier: FramekitRenderArtifactVerifier,
  options: FramekitRenderAndVerifyOptions = {},
): Promise<FramekitRenderAndVerifyResult> {
  let plan: FramekitRenderPlan;
  try {
    const capabilities = options.capabilities ?? provider.capabilities(request);
    plan = createFramekitRenderPlan(request, capabilities);
  } catch (error) {
    return failureResult(error, options.isUnavailable);
  }

  let render: FramekitRenderProviderResult;
  try {
    render = await provider.render(plan);
  } catch (error) {
    return { ...failureResult(error, options.isUnavailable), plan };
  }

  const binding = checkRenderBinding(plan, render);
  if (!binding.passed) {
    return {
      status: "failed",
      plan,
      render,
      verification: { status: "failed", checks: [binding] },
    };
  }

  let verification: FramekitRenderVerificationResult;
  try {
    verification = await verifier.verify(plan, render);
  } catch (error) {
    return {
      status: "failed",
      plan,
      render,
      verification: {
        status: "failed",
        checks: [],
        error: errorDetails(error),
      },
    };
  }
  if (verification.status !== "passed" || !verification.artifact) {
    if (verification.status === "passed" && !verification.artifact) {
      const invalidVerification: FramekitRenderVerificationResult = {
        ...verification,
        status: "failed",
        checks: [...verification.checks, {
          name: "artifact",
          passed: false,
          detail: "a passed render verification must include artifact metadata",
        }],
        error: { code: "RENDER_VERIFICATION_CONTRACT_INVALID", message: "passed verification omitted artifact metadata" },
      };
      return { status: "failed", plan, render, verification: invalidVerification };
    }
    return { status: verification.status, plan, render, verification };
  }

  const semanticChecks = await Promise.all((options.semanticAssertions ?? []).map(async (assertion) => {
    try {
      const value = await assertion.verify({ plan, result: render, artifact: verification.artifact! });
      return typeof value === "boolean"
        ? { name: assertion.name, passed: value, detail: value ? "semantic assertion passed" : "semantic assertion failed" }
        : { ...value, name: value.name || assertion.name };
    } catch (error) {
      return { name: assertion.name, passed: false, detail: errorDetails(error).message };
    }
  }));
  const checks = [...verification.checks, ...semanticChecks];
  const passed = checks.every((check) => check.passed);
  return {
    status: passed ? "passed" : "failed",
    plan,
    render,
    verification: { ...verification, status: passed ? "passed" : "failed", checks },
  };
}

function checkRenderBinding(plan: FramekitRenderPlan, result: FramekitRenderProviderResult): FramekitRenderVerificationCheck {
  const passed = result.contractVersion === plan.contractVersion
    && sameTarget(plan.target, result.target)
    && sameRevision(plan.projectRevision, result.projectRevision)
    && result.renderer.id === plan.renderer.id
    && result.renderer.version === plan.renderer.version
    && result.planDigest === plan.planDigest
    && result.output.path === plan.parameters.outputPath
    && result.output.format === plan.parameters.format
    && result.verificationRequired === true;
  return {
    name: "render-binding",
    passed,
    detail: passed
      ? "render output is bound to the requested target, revision, renderer, plan, and format"
      : "render output provenance does not match the requested plan",
    expected: {
      target: plan.target,
      projectRevision: plan.projectRevision,
      renderer: plan.renderer,
      planDigest: plan.planDigest,
      output: plan.parameters,
    },
    observed: result,
  };
}

function failureResult(error: unknown, isUnavailable?: (error: unknown) => boolean): FramekitRenderAndVerifyResult {
  const details = errorDetails(error);
  const unavailable = isUnavailable?.(error) ?? /UNAVAILABLE|CAPABILITY_UNAVAILABLE|unsupported/i.test(`${details.code} ${details.message}`);
  return { status: unavailable ? "unavailable" : "failed", error: details };
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(error.message);
    return { code: match?.[1] ?? error.name, message: match?.[2] ?? error.message };
  }
  return { code: "RENDER_ORCHESTRATION_FAILED", message: String(error) };
}

function sameTarget(left: { projectId: string; sequenceId: string }, right: { projectId: string; sequenceId: string }): boolean {
  return left.projectId === right.projectId && left.sequenceId === right.sequenceId;
}

function sameRevision(left: { id: string; sequence: number; timestamp: string }, right: { id: string; sequence: number; timestamp: string }): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}
