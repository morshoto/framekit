import { createHash } from "node:crypto";

export type BriefChoice = { kind: "specified"; value: string } | { kind: "no-preference" };

/** User choices and proposed inferences remain distinct until explicitly reviewed. */
export interface CreativeBrief {
  schemaVersion: 1;
  id: string;
  version: number;
  purpose: BriefChoice;
  audience: BriefChoice;
  durationSeconds: { min: number; max: number };
  aspectRatio: string;
  theme: string;
  visualDirection: string;
  requiredContent: string[];
  excludedContent: string[];
  speechPolicy: BriefChoice;
  musicPolicy: BriefChoice;
  captionPolicy: BriefChoice;
  sourceCoverage: { requirement: string; sourceId: string; start: number; end: number }[];
  inferences: { field: string; value: string; reason: string; accepted: boolean }[];
  reviewPrompts: string[];
}

export interface AcceptedCreativeBrief {
  id: string;
  version: number;
  digest: string;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(brief: CreativeBrief): string {
  return createHash("sha256").update(canonical(brief)).digest("hex");
}

export interface CreativeBriefReview {
  missingCoverage: string[];
  pendingInferences: string[];
}

/** Review is read-only and makes outstanding decisions visible before acceptance. */
export function reviewCreativeBrief(brief: CreativeBrief): CreativeBriefReview {
  if (!brief || brief.schemaVersion !== 1 || !nonempty(brief.id) || !Number.isSafeInteger(brief.version) || brief.version < 1) throw new Error("INVALID_BRIEF: identity and version are required");
  for (const choice of [brief.purpose, brief.audience, brief.speechPolicy, brief.musicPolicy, brief.captionPolicy]) {
    if (!choice || (choice.kind !== "no-preference" && (choice.kind !== "specified" || !nonempty(choice.value)))) throw new Error("INVALID_BRIEF: purpose, audience and policies require explicit choices");
  }
  const duration = brief.durationSeconds;
  if (!duration || !Number.isFinite(duration.min) || !Number.isFinite(duration.max) || duration.min <= 0 || duration.max < duration.min) throw new Error("INVALID_BRIEF: invalid duration");
  if (![brief.aspectRatio, brief.theme, brief.visualDirection].every(nonempty)) throw new Error("INVALID_BRIEF: format and policies are required");
  if (!Array.isArray(brief.requiredContent) || !Array.isArray(brief.excludedContent) || !Array.isArray(brief.reviewPrompts) || !Array.isArray(brief.sourceCoverage) || !Array.isArray(brief.inferences)) throw new Error("INVALID_BRIEF: content and review lists are required");
  if (![...brief.requiredContent, ...brief.excludedContent, ...brief.reviewPrompts].every(nonempty)) throw new Error("INVALID_BRIEF: empty content or review prompt");
  for (const coverage of brief.sourceCoverage) {
    if (!coverage || !nonempty(coverage.requirement) || !nonempty(coverage.sourceId) || !Number.isFinite(coverage.start) || !Number.isFinite(coverage.end) || coverage.start < 0 || coverage.end <= coverage.start) throw new Error("INVALID_BRIEF: invalid source coverage");
  }
  for (const item of brief.inferences) {
    if (!item || !nonempty(item.field) || !nonempty(item.value) || !nonempty(item.reason) || typeof item.accepted !== "boolean") throw new Error("INVALID_BRIEF: invalid inference");
  }
  return {
    missingCoverage: brief.requiredContent.filter((item) => !brief.sourceCoverage.some((coverage) => coverage.requirement === item)),
    pendingInferences: brief.inferences.filter((item) => !item.accepted).map((item) => item.field),
  };
}

/** Acceptance is an explicit caller action, not an inference from a complete draft. */
export function acceptCreativeBrief(brief: CreativeBrief): AcceptedCreativeBrief {
  const review = reviewCreativeBrief(brief);
  if (review.missingCoverage.length) throw new Error("INVALID_BRIEF: missing source coverage");
  if (review.pendingInferences.length) throw new Error("INVALID_BRIEF: inference requires review");
  return { id: brief.id, version: brief.version, digest: digest(brief) };
}

/** Make a detached new version; existing acceptance remains bound to the old version. */
export function reviseCreativeBrief(previous: CreativeBrief, proposed: CreativeBrief): CreativeBrief {
  reviewCreativeBrief(previous);
  if (proposed.id !== previous.id || proposed.version !== previous.version) throw new Error("INVALID_BRIEF: revision must preserve identity and base version");
  if (previous.version === Number.MAX_SAFE_INTEGER) throw new Error("INVALID_BRIEF: version overflow");
  const revised = structuredClone({ ...proposed, version: previous.version + 1 });
  reviewCreativeBrief(revised);
  return revised;
}

/** Downstream plans must call this before use to reject changed requirements. */
export function assertBriefBinding(accepted: AcceptedCreativeBrief, current: CreativeBrief): void {
  if (accepted.id !== current.id || accepted.version !== current.version || accepted.digest !== digest(current)) throw new Error("STALE_BRIEF: accepted brief has changed");
  acceptCreativeBrief(current);
}
