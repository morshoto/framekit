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
  speechPolicy: string;
  musicPolicy: string;
  captionPolicy: string;
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
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(brief: CreativeBrief): string {
  return createHash("sha256").update(canonical(brief)).digest("hex");
}

export function acceptCreativeBrief(brief: CreativeBrief): AcceptedCreativeBrief {
  if (brief.schemaVersion !== 1 || !nonempty(brief.id) || !Number.isSafeInteger(brief.version) || brief.version < 1) throw new Error("INVALID_BRIEF: identity and version are required");
  for (const choice of [brief.purpose, brief.audience]) {
    if (!choice || (choice.kind !== "no-preference" && (choice.kind !== "specified" || !nonempty(choice.value)))) throw new Error("INVALID_BRIEF: purpose and audience require explicit choices");
  }
  const { min, max } = brief.durationSeconds;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) throw new Error("INVALID_BRIEF: invalid duration");
  if (![brief.aspectRatio, brief.theme, brief.visualDirection, brief.speechPolicy, brief.musicPolicy, brief.captionPolicy].every(nonempty)) throw new Error("INVALID_BRIEF: format and policies are required");
  if (![...brief.requiredContent, ...brief.excludedContent, ...brief.reviewPrompts].every(nonempty)) throw new Error("INVALID_BRIEF: empty content or review prompt");
  for (const coverage of brief.sourceCoverage) {
    if (!nonempty(coverage.requirement) || !nonempty(coverage.sourceId) || !Number.isFinite(coverage.start) || !Number.isFinite(coverage.end) || coverage.start < 0 || coverage.end <= coverage.start) throw new Error("INVALID_BRIEF: invalid source coverage");
  }
  if (brief.requiredContent.some((item) => !brief.sourceCoverage.some((coverage) => coverage.requirement === item))) throw new Error("INVALID_BRIEF: missing source coverage");
  if (brief.inferences.some((item) => !nonempty(item.field) || !nonempty(item.value) || !nonempty(item.reason) || item.accepted !== true)) throw new Error("INVALID_BRIEF: inference requires review");
  return { id: brief.id, version: brief.version, digest: digest(brief) };
}

/** Downstream plans must call this before use to reject changed requirements. */
export function assertBriefBinding(accepted: AcceptedCreativeBrief, current: CreativeBrief): void {
  if (accepted.id !== current.id || accepted.version !== current.version || accepted.digest !== digest(current)) throw new Error("STALE_BRIEF: accepted brief has changed");
  acceptCreativeBrief(current);
}
