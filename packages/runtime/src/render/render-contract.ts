import { createHash } from "node:crypto";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";
import { validateTimelineIr, type TimelineIr } from "../timeline/editing-session.js";
import { parseRational } from "../timeline/rational-time.js";

export const FRAMEKIT_RENDER_CONTRACT_VERSION = 1 as const;

export type FramekitRenderFormat = "mp4" | "mov";
export type FramekitRenderFeature =
  | "local-media"
  | "structural-edits"
  | "audio-gain"
  | "transform"
  | "titles"
  | "cross-dissolve";
export type FramekitRenderCapabilityStatus = "supported" | "degraded" | "unsupported";

export interface FramekitRenderParameters {
  outputPath: string;
  format: FramekitRenderFormat;
  width: number;
  height: number;
  frameRate: RationalTime;
  overwrite?: boolean;
}

export interface FramekitRenderRequest {
  contractVersion: typeof FRAMEKIT_RENDER_CONTRACT_VERSION;
  target: { projectId: string; sequenceId: string };
  projectRevision: ContextRevision;
  timeline: TimelineIr;
  parameters: FramekitRenderParameters;
  requiredFeatures: FramekitRenderFeature[];
}

export interface FramekitRenderRequestInput {
  timeline: TimelineIr;
  target: { projectId: string; sequenceId: string };
  revision?: ContextRevision;
  parameters: FramekitRenderParameters;
  requiredFeatures?: FramekitRenderFeature[];
}

export interface FramekitRenderCapabilityReport {
  renderer: { id: string; version: string };
  features: Partial<Record<FramekitRenderFeature, FramekitRenderCapabilityStatus>>;
}

export interface FramekitRenderPlan {
  contractVersion: typeof FRAMEKIT_RENDER_CONTRACT_VERSION;
  target: { projectId: string; sequenceId: string };
  projectRevision: ContextRevision;
  timeline: TimelineIr;
  parameters: FramekitRenderParameters;
  requiredFeatures: FramekitRenderFeature[];
  renderer: { id: string; version: string };
  capabilities: FramekitRenderCapabilityReport;
  planDigest: string;
}

export interface FramekitRenderProviderResult {
  contractVersion: typeof FRAMEKIT_RENDER_CONTRACT_VERSION;
  status: "rendered";
  target: { projectId: string; sequenceId: string };
  projectRevision: ContextRevision;
  renderer: { id: string; version: string };
  planDigest: string;
  output: { path: string; format: FramekitRenderFormat };
  /** Rendering and independent artifact verification are separate gates. */
  verificationRequired: true;
}

export interface FramekitRenderProvider {
  readonly id: string;
  readonly version: string;
  capabilities(request: FramekitRenderRequest): FramekitRenderCapabilityReport;
  render(plan: FramekitRenderPlan): Promise<FramekitRenderProviderResult>;
}

export class FramekitRenderContractError extends Error {
  public constructor(
    public readonly code: "RENDER_INVALID_REQUEST" | "RENDER_STALE_REVISION" | "RENDER_CAPABILITY_UNAVAILABLE" | "RENDER_INVALID_RESULT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FramekitRenderContractError";
  }
}

export function createFramekitRenderRequest(input: FramekitRenderRequestInput): FramekitRenderRequest {
  validateTimelineIr(input.timeline);
  if (!text(input.target?.projectId) || !text(input.target?.sequenceId)) {
    throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "target requires projectId and sequenceId");
  }
  if (input.target.projectId !== input.timeline.project.id || input.target.sequenceId !== input.timeline.sequence.id) {
    throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "target does not match the Timeline IR");
  }
  if (input.revision && !sameRevision(input.revision, input.timeline.revision)) {
    throw new FramekitRenderContractError("RENDER_STALE_REVISION", "requested revision does not match the Timeline IR");
  }
  validateParameters(input.parameters);
  const requiredFeatures = [...new Set([
    ...inferFramekitRenderFeatures(input.timeline),
    ...(input.requiredFeatures ?? []),
  ])];
  for (const feature of requiredFeatures) {
    if (!RENDER_FEATURES.includes(feature)) throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", `unsupported required feature: ${feature}`);
  }
  return deepFreeze({
    contractVersion: FRAMEKIT_RENDER_CONTRACT_VERSION,
    target: structuredClone(input.target),
    projectRevision: structuredClone(input.timeline.revision),
    timeline: structuredClone(input.timeline),
    parameters: structuredClone(input.parameters),
    requiredFeatures,
  });
}

export function inferFramekitRenderFeatures(timeline: TimelineIr): FramekitRenderFeature[] {
  const features: FramekitRenderFeature[] = ["local-media", "structural-edits"];
  if (timeline.sequence.occurrences.some(({ gainDb }) => gainDb !== undefined)) features.push("audio-gain");
  if (timeline.sequence.occurrences.some(({ transform }) => transform !== undefined)) features.push("transform");
  if ((timeline.sequence.titles ?? []).length > 0) features.push("titles");
  if ((timeline.sequence.transitions ?? []).some(({ kind }) => kind === "cross-dissolve")) features.push("cross-dissolve");
  return features;
}

export function createFramekitRenderPlan(
  request: FramekitRenderRequest,
  capabilities: FramekitRenderCapabilityReport,
): FramekitRenderPlan {
  if (!text(capabilities.renderer?.id) || !text(capabilities.renderer?.version)) {
    throw new FramekitRenderContractError("RENDER_INVALID_RESULT", "renderer identity and version are required");
  }
  const unavailable = request.requiredFeatures.filter((feature) => capabilities.features[feature] !== "supported");
  if (unavailable.length > 0) {
    throw new FramekitRenderContractError(
      "RENDER_CAPABILITY_UNAVAILABLE",
      `required features are not fully supported: ${unavailable.join(", ")}`,
    );
  }
  const planBase = {
    contractVersion: FRAMEKIT_RENDER_CONTRACT_VERSION,
    target: structuredClone(request.target),
    projectRevision: structuredClone(request.projectRevision),
    timeline: structuredClone(request.timeline),
    parameters: structuredClone(request.parameters),
    requiredFeatures: [...request.requiredFeatures],
    renderer: structuredClone(capabilities.renderer),
    capabilities: structuredClone(capabilities),
  } satisfies Omit<FramekitRenderPlan, "planDigest">;
  const plan = {
    ...planBase,
    planDigest: createHash("sha256").update(stableJson(planBase)).digest("hex"),
  };
  return deepFreeze(plan);
}

export function createFramekitRenderResult(
  plan: FramekitRenderPlan,
  output: { path: string; format: FramekitRenderFormat },
): FramekitRenderProviderResult {
  assertPlanIntegrity(plan);
  if (!text(output.path) || output.path !== plan.parameters.outputPath || output.format !== plan.parameters.format) {
    throw new FramekitRenderContractError("RENDER_INVALID_RESULT", "render output must match the explicit request format and path");
  }
  return {
    contractVersion: FRAMEKIT_RENDER_CONTRACT_VERSION,
    status: "rendered",
    target: structuredClone(plan.target),
    projectRevision: structuredClone(plan.projectRevision),
    renderer: structuredClone(plan.renderer),
    planDigest: plan.planDigest,
    output: structuredClone(output),
    verificationRequired: true,
  };
}

const RENDER_FEATURES: FramekitRenderFeature[] = [
  "local-media",
  "structural-edits",
  "audio-gain",
  "transform",
  "titles",
  "cross-dissolve",
];

function validateParameters(parameters: FramekitRenderParameters): void {
  if (!parameters || typeof parameters !== "object" || !text(parameters.outputPath)) {
    throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "outputPath is required");
  }
  if (parameters.format !== "mp4" && parameters.format !== "mov") {
    throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "format must be mp4 or mov");
  }
  if (!Number.isSafeInteger(parameters.width) || parameters.width <= 0 || !Number.isSafeInteger(parameters.height) || parameters.height <= 0) {
    throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "width and height must be positive safe integers");
  }
  const frameRate = parseRational(parameters.frameRate, "RENDER_INVALID_REQUEST");
  if (frameRate.value <= 0n) throw new FramekitRenderContractError("RENDER_INVALID_REQUEST", "frameRate must be positive");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function assertPlanIntegrity(plan: FramekitRenderPlan): void {
  const { planDigest, ...planBase } = plan;
  const actualDigest = createHash("sha256").update(stableJson(planBase)).digest("hex");
  if (actualDigest !== planDigest) {
    throw new FramekitRenderContractError("RENDER_INVALID_RESULT", "render plan was modified after it was created");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
