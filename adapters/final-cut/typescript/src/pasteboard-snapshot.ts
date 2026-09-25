import { createHash } from "node:crypto";

export const FINAL_CUT_PASTEBOARD_UTI = "com.apple.flexo.proFFPasteboardUTI" as const;

export interface FinalCutPasteboardObservationInput {
  uti: string;
  sourceVersion: string;
  /** Decoded, sanitized payload supplied by the native pasteboard bridge. */
  payload: unknown;
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
  provenance: {
    uti: typeof FINAL_CUT_PASTEBOARD_UTI;
    sourceVersion: string;
  };
  payloadDigest: string;
  items: FinalCutPasteboardItem[];
  anchoredItems: FinalCutPasteboardItem[];
  coverage: {
    containers: "complete";
    occurrences: "observed";
    sourceBindings: "observed";
    timing: "observed";
    anchoredItems: "complete";
  };
}

export function decodeFinalCutPasteboardObservation(
  input: FinalCutPasteboardObservationInput,
): FinalCutPasteboardObservation {
  if (input.uti !== FINAL_CUT_PASTEBOARD_UTI) {
    throw new Error("FINAL_CUT_PASTEBOARD_UTI_UNSUPPORTED: expected Final Cut timeline pasteboard payload");
  }
  if (!input.sourceVersion.trim()) throw new Error("FINAL_CUT_PASTEBOARD_PROVENANCE_MISSING: source version is required");
  const payload = record(input.payload);
  const timeline = record(payload.timeline);
  const rawItems = timeline.items;
  const rawAnchoredItems = timeline.anchoredItems;
  if (!Array.isArray(rawItems) || !Array.isArray(rawAnchoredItems)) {
    throw new Error("FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: timeline containers are unavailable");
  }
  const items = rawItems.map((item, index) => parseItem(item, `timeline item ${index + 1}`));
  const anchoredItems = rawAnchoredItems.map((item, index) => parseItem(item, `anchored item ${index + 1}`));
  return {
    provider: "final-cut-pasteboard",
    canonical: false,
    provenance: { uti: FINAL_CUT_PASTEBOARD_UTI, sourceVersion: input.sourceVersion },
    payloadDigest: createHash("sha256").update(stableJson(payload)).digest("hex"),
    items,
    anchoredItems,
    coverage: {
      containers: "complete",
      occurrences: "observed",
      sourceBindings: "observed",
      timing: "observed",
      anchoredItems: "complete",
    },
  };
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
  if (item.duration <= 0) throw new Error(`FINAL_CUT_PASTEBOARD_COVERAGE_INCOMPLETE: ${label} has invalid duration`);
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
