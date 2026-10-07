import { createHash } from "node:crypto";
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
