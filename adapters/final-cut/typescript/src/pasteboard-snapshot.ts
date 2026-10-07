import { createHash } from "node:crypto";
import {
  normalizeFastTimelineObservation,
  timelineIrDigest,
  type FastTimelineObservation,
  type TimelineIr,
} from "@framekit/runtime";
import type { ContextRevision } from "@framekit/runtime";
import {
  decodeFinalCutKeyedArchive,
  type FinalCutKeyedArchiveJsonDecoder,
  type ParsedFinalCutKeyedArchive,
} from "./sqlite-experiment.js";

export const FINAL_CUT_PASTEBOARD_UTI = "com.apple.flexo.proFFPasteboardUTI" as const;

export type FinalCutPasteboardCoverage = "complete" | "partial" | "unavailable";

export interface FinalCutPasteboardTarget {
  projectId: string;
  sequenceId: string;
}

export interface FinalCutPasteboardSideEffects {
  foregroundActivated: boolean | "unknown";
  selectionChanged: boolean | "unknown";
  clipboardChanged: boolean | "unknown";
  clipboardRestored: boolean | "unknown";
  focusRestored: boolean | "unknown";
}

export interface FinalCutPasteboardObservationInput {
  uti: string;
  sourceVersion: string;
  /** Decoded, sanitized payload supplied by the explicit acquisition boundary. */
  payload: unknown;
  target: FinalCutPasteboardTarget;
  sideEffects: FinalCutPasteboardSideEffects;
}

export interface FinalCutPasteboardItem {
  occurrenceId: string;
  resourceId: string;
  start: number;
  duration: number;
  lane: number;
  role?: string;
}

export interface FinalCutPasteboardObservation {
  provider: "final-cut-pasteboard";
  canonical: false;
  target: FinalCutPasteboardTarget;
  sideEffects: FinalCutPasteboardSideEffects;
  provenance: {
    uti: typeof FINAL_CUT_PASTEBOARD_UTI;
    sourceVersion: string;
  };
  payloadDigest: string;
  items: FinalCutPasteboardItem[];
  anchoredItems: FinalCutPasteboardItem[];
  unknownFields: string[];
  coverage: {
    containers: FinalCutPasteboardCoverage;
    occurrences: FinalCutPasteboardCoverage;
    sourceBindings: FinalCutPasteboardCoverage;
    timing: FinalCutPasteboardCoverage;
    anchoredItems: FinalCutPasteboardCoverage;
  };
}

export interface FinalCutPasteboardTimelineNormalizationOptions {
  framekitRevision: ContextRevision;
  artifactDigest: string;
  providerRevision: ContextRevision;
  observedAt: string;
  projectName: string;
  sequenceName: string;
  timeUnit: "frames" | "seconds";
  timescale: number;
  sequenceDuration?: number;
}

export type FinalCutPasteboardCaptureStatus = "captured" | "user-interaction-required" | "unsupported" | "failed";

export interface FinalCutPasteboardCaptureRequest {
  target: FinalCutPasteboardTarget;
  /** Must be explicit because Select All -> Copy changes focus, selection, and clipboard state. */
  allowInteraction: boolean;
  restoreClipboard: boolean;
}

export interface FinalCutPasteboardCaptureResult {
  status: FinalCutPasteboardCaptureStatus;
  route: "headed-pasteboard-copy";
  target: {
    requested: FinalCutPasteboardTarget;
    observed?: FinalCutPasteboardTarget;
    guarantee: "requested-and-observed" | "requested-unverified" | "unavailable";
  };
  sideEffects: FinalCutPasteboardSideEffects;
  /** A decoded payload is required before the observation can be normalized. */
  payload?: unknown;
  payloadDigest?: string;
  error?: { code: string; message: string };
}

export interface FinalCutPasteboardCapturePort {
  capture(request: FinalCutPasteboardCaptureRequest): Promise<FinalCutPasteboardCaptureResult>;
}

export interface FinalCutPasteboardProviderOptions {
  sourceVersion: string;
  capture?: FinalCutPasteboardCapturePort;
}

export type FinalCutPasteboardProviderResult = FinalCutPasteboardObservation | FinalCutPasteboardCaptureResult;

/**
 * Experimental, non-canonical fallback. Without an explicit headed acquisition
 * port this provider is unavailable; it never turns caller-supplied data into
 * evidence of a live Final Cut read by itself.
 */
export class FinalCutPasteboardProvider {
  private readonly sourceVersion: string;
  private readonly capture?: FinalCutPasteboardCapturePort;

  public constructor(options: FinalCutPasteboardProviderOptions) {
    this.sourceVersion = options.sourceVersion.trim();
    if (!this.sourceVersion) throw new Error("FINAL_CUT_PASTEBOARD_PROVENANCE_MISSING: source version is required");
    this.capture = options.capture;
  }

  public async observe(request: FinalCutPasteboardCaptureRequest): Promise<FinalCutPasteboardProviderResult> {
    if (!request.allowInteraction) {
      return blockedCapture(request, "FINAL_CUT_PASTEBOARD_INTERACTION_REQUIRED", "pasteboard capture requires explicit focus, selection, and clipboard side effects");
    }
    if (!this.capture) {
      return blockedCapture(request, "FINAL_CUT_PASTEBOARD_CAPTURE_UNAVAILABLE", "no headed pasteboard acquisition port is configured");
    }
    const captured = await this.capture.capture(request);
    if (captured.status !== "captured") return captured;
    if (!captured.payload) {
      return {
        ...captured,
        status: "failed",
        error: { code: "FINAL_CUT_PASTEBOARD_PAYLOAD_UNAVAILABLE", message: "capture completed without a decoded pasteboard payload" },
      };
    }
    if (!sameTarget(captured.target.requested, request.target)
      || !sameTarget(captured.target.observed, request.target)
      || captured.target.guarantee !== "requested-and-observed") {
      return {
        ...captured,
        status: "failed",
        error: { code: "FINAL_CUT_PASTEBOARD_TARGET_UNVERIFIED", message: "pasteboard payload is not bound to the requested project and sequence" },
      };
    }
    return decodeFinalCutPasteboardObservation({
      uti: FINAL_CUT_PASTEBOARD_UTI,
      sourceVersion: this.sourceVersion,
      payload: captured.payload,
      target: request.target,
      sideEffects: captured.sideEffects,
    });
  }
}

export async function decodeFinalCutPasteboardArchive(
  payload: Uint8Array,
  decoder?: FinalCutKeyedArchiveJsonDecoder,
): Promise<{ payloadDigest: string; archive: ParsedFinalCutKeyedArchive }> {
  const bytes = Uint8Array.from(payload);
  const archive = await decodeFinalCutKeyedArchive(bytes, decoder);
  return { payloadDigest: createHash("sha256").update(bytes).digest("hex"), archive };
}

export function decodeFinalCutPasteboardObservation(
  input: FinalCutPasteboardObservationInput,
): FinalCutPasteboardObservation {
  if (input.uti !== FINAL_CUT_PASTEBOARD_UTI) {
    throw new Error("FINAL_CUT_PASTEBOARD_UTI_UNSUPPORTED: expected Final Cut timeline pasteboard payload");
  }
  const sourceVersion = input.sourceVersion.trim();
  if (!sourceVersion) throw new Error("FINAL_CUT_PASTEBOARD_PROVENANCE_MISSING: source version is required");
  const target = parseTarget(input.target);
  const sideEffects = parseSideEffects(input.sideEffects);
  const payload = record(input.payload);
  const timeline = record(payload.timeline);
  const rawItems = timeline.items;
  const rawAnchoredItems = timeline.anchoredItems;
  if (!Array.isArray(rawItems)) {
    throw new Error("FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: timeline containers are unavailable");
  }
  const items = rawItems.map((item, index) => parseItem(item, `timeline item ${index + 1}`));
  const anchoredItems = Array.isArray(rawAnchoredItems)
    ? rawAnchoredItems.map((item, index) => parseItem(item, `anchored item ${index + 1}`))
    : [];
  const unknownFields = [
    "timeline.containerCompleteness",
    "occurrences.completeness",
    "sourceBindings.completeness",
    "timing.completeness",
    ...(Array.isArray(rawAnchoredItems) ? [] : ["anchoredItems"]),
  ];
  return {
    provider: "final-cut-pasteboard",
    canonical: false,
    target,
    sideEffects,
    provenance: { uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion },
    payloadDigest: createHash("sha256").update(stableJson(payload)).digest("hex"),
    items,
    anchoredItems,
    unknownFields,
    coverage: {
      containers: Array.isArray(rawAnchoredItems) ? "complete" : "partial",
      occurrences: "partial",
      sourceBindings: "partial",
      timing: "partial",
      anchoredItems: Array.isArray(rawAnchoredItems) ? "partial" : "unavailable",
    },
  };
}

/** Convert only the fields the pasteboard decoder actually proved into the runtime envelope. */
export function normalizeFinalCutPasteboardObservation(
  input: FinalCutPasteboardObservation,
  options: FinalCutPasteboardTimelineNormalizationOptions,
): FastTimelineObservation {
  const timescale = integer(options.timescale, "timescale");
  const target = parseTarget(input.target);
  const projectName = requiredText(options.projectName, "projectName");
  const sequenceName = requiredText(options.sequenceName, "sequenceName");
  const resources = new Map<string, TimelineIr["resources"][number]>();
  const occurrences = input.items.map((item) => {
    if (!resources.has(item.resourceId)) {
      resources.set(item.resourceId, {
        id: item.resourceId,
        name: item.resourceId,
        mediaKind: item.role === "audio" || item.role === "music" ? "audio" : "video",
        binding: { provider: "final-cut", kind: "resource", identity: item.resourceId },
      });
    }
    return {
      id: item.occurrenceId,
      name: item.occurrenceId,
      startTime: toRational(item.start, options.timeUnit, timescale, "item start"),
      durationTime: toRational(item.duration, options.timeUnit, timescale, "item duration"),
      track: item.lane,
      ...(item.role ? { role: item.role === "music" ? "music" : item.role === "audio" ? "audio" : "video" } : {}),
      mediaId: item.resourceId,
      binding: { provider: "final-cut", kind: "occurrence", identity: item.occurrenceId },
    } satisfies TimelineIr["sequence"]["occurrences"][number];
  });
  const anchoredItems = input.anchoredItems.map((item) => ({
    id: item.occurrenceId,
    name: item.occurrenceId,
    startTime: toRational(item.start, options.timeUnit, timescale, "anchored item start"),
    durationTime: toRational(item.duration, options.timeUnit, timescale, "anchored item duration"),
    track: item.lane,
    ...(item.role ? { role: item.role === "music" ? "music" : item.role === "audio" ? "audio" : "video" } : {}),
    mediaId: item.resourceId,
    attachedTo: item.occurrenceId,
    binding: { provider: "final-cut", kind: "occurrence", identity: item.occurrenceId },
  } satisfies TimelineIr["sequence"]["occurrences"][number]));
  const allItems = [...input.items, ...input.anchoredItems];
  const computedDuration = allItems.reduce((end, item) => Math.max(end, item.start + item.duration), 0);
  const duration = toRational(options.sequenceDuration ?? computedDuration, options.timeUnit, timescale, "sequence duration");
  const timeline: TimelineIr = {
    schemaVersion: 1,
    project: {
      id: target.projectId,
      name: projectName,
      binding: { provider: "final-cut", kind: "project", identity: target.projectId },
    },
    sequence: {
      id: target.sequenceId,
      name: sequenceName,
      durationTime: duration,
      frameDuration: { value: "1", timescale: String(timescale) },
      occurrences: [...occurrences, ...anchoredItems],
      storyElements: [],
      markers: [],
      captions: [],
      binding: { provider: "final-cut", kind: "sequence", identity: target.sequenceId },
    },
    resources: [...resources.values()],
    revision: structuredClone(options.providerRevision),
  };
  const unknowns = [...input.unknownFields];
  for (const [field, state] of Object.entries(input.coverage)) {
    if (state !== "complete") unknowns.push(`coverage.${field}`);
  }
  for (const [field, state] of Object.entries(input.sideEffects)) {
    if (state === "unknown") unknowns.push(`sideEffects.${field}`);
  }
  unknowns.push("storylineRelationships", "markersCaptions");
  const freshness = Object.values(input.sideEffects).every((state) => typeof state === "boolean")
    ? "editor-read" as const
    : "unknown" as const;
  return normalizeFastTimelineObservation({
    schemaVersion: 1,
    provider: "final-cut",
    sourceType: "pasteboard",
    canonical: false,
    target,
    provenance: {
      framekitRevision: structuredClone(options.framekitRevision),
      artifactDigest: requiredText(options.artifactDigest, "artifactDigest"),
      target,
    },
    observedAt: requiredText(options.observedAt, "observedAt"),
    trust: "normalized",
    freshness,
    revision: structuredClone(options.providerRevision),
    observationDigest: input.payloadDigest,
    timelineDigest: timelineIrDigest(timeline),
    coverage: {
      occurrences: input.coverage.occurrences === "complete" ? "complete" : "partial",
      resources: input.coverage.sourceBindings === "complete" ? "complete" : "partial",
      timing: input.coverage.timing === "complete" ? "complete" : "partial",
      roles: input.coverage.sourceBindings === "complete" ? "complete" : "partial",
      storylineRelationships: "unknown",
      markersCaptions: "unknown",
    },
    unknowns: [...new Set(unknowns)],
    timeline,
  });
}

function blockedCapture(
  request: FinalCutPasteboardCaptureRequest,
  code: string,
  message: string,
): FinalCutPasteboardCaptureResult {
  return {
    status: code === "FINAL_CUT_PASTEBOARD_CAPTURE_UNAVAILABLE" ? "unsupported" : "user-interaction-required",
    route: "headed-pasteboard-copy",
    target: { requested: request.target, guarantee: "unavailable" },
    sideEffects: unknownSideEffects(),
    error: { code, message },
  };
}

function parseTarget(value: FinalCutPasteboardTarget): FinalCutPasteboardTarget {
  if (!value || typeof value.projectId !== "string" || !value.projectId.trim()
    || typeof value.sequenceId !== "string" || !value.sequenceId.trim()) {
    throw new Error("FINAL_CUT_PASTEBOARD_TARGET_UNAVAILABLE: project and sequence identities are required");
  }
  return { projectId: value.projectId.trim(), sequenceId: value.sequenceId.trim() };
}

function parseSideEffects(value: FinalCutPasteboardSideEffects): FinalCutPasteboardSideEffects {
  const keys: Array<keyof FinalCutPasteboardSideEffects> = [
    "foregroundActivated",
    "selectionChanged",
    "clipboardChanged",
    "clipboardRestored",
    "focusRestored",
  ];
  if (!value || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)
    || (value[key] !== "unknown" && typeof value[key] !== "boolean"))) {
    throw new Error("FINAL_CUT_PASTEBOARD_SIDE_EFFECTS_INVALID: capture side effects must be explicit");
  }
  return {
    foregroundActivated: value.foregroundActivated,
    selectionChanged: value.selectionChanged,
    clipboardChanged: value.clipboardChanged,
    clipboardRestored: value.clipboardRestored,
    focusRestored: value.focusRestored,
  };
}

function unknownSideEffects(): FinalCutPasteboardSideEffects {
  return {
    foregroundActivated: "unknown",
    selectionChanged: "unknown",
    clipboardChanged: "unknown",
    clipboardRestored: "unknown",
    focusRestored: "unknown",
  };
}

function sameTarget(left: FinalCutPasteboardTarget | undefined, right: FinalCutPasteboardTarget): boolean {
  return left?.projectId === right.projectId && left.sequenceId === right.sequenceId;
}

function parseItem(value: unknown, label: string): FinalCutPasteboardItem {
  const item = record(value);
  if (typeof item.occurrenceId !== "string" || !item.occurrenceId.trim()
    || typeof item.resourceId !== "string" || !item.resourceId.trim()) {
    throw new Error(`FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: ${label} lacks stable identities`);
  }
  for (const key of ["start", "duration", "lane"] as const) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key])) {
      throw new Error(`FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: ${label} lacks finite ${key}`);
    }
  }
  if (item.start < 0 || item.duration <= 0 || item.lane < 0) {
    throw new Error(`FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: ${label} has invalid timeline coordinates`);
  }
  return {
    occurrenceId: item.occurrenceId,
    resourceId: item.resourceId,
    start: item.start,
    duration: item.duration,
    lane: item.lane,
    ...(typeof item.role === "string" && item.role.trim() ? { role: item.role } : {}),
  };
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toRational(value: number, unit: "frames" | "seconds", timescale: number, label: string): { value: string; timescale: string } {
  if (!Number.isFinite(value) || value < 0) throw new Error(`FINAL_CUT_PASTEBOARD_TIMING_INVALID: ${label} must be non-negative and finite`);
  const frames = unit === "frames" ? value : value * timescale;
  if (!Number.isSafeInteger(frames)) throw new Error(`FINAL_CUT_PASTEBOARD_TIMING_INVALID: ${label} is not exactly representable at ${timescale} fps`);
  return { value: String(frames), timescale: String(timescale) };
}

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`FINAL_CUT_PASTEBOARD_INPUT_INVALID: ${name} must be a positive integer`);
  return value;
}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`FINAL_CUT_PASTEBOARD_INPUT_INVALID: ${name} is required`);
  return value.trim();
}
