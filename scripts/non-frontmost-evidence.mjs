const evidenceTierByMode = Object.freeze({
  fixture: "deterministic",
  "fcpxml-artifact": "artifact",
  "metadata-only": "metadata-only",
  "canonical-live": "canonical-live",
  "native-write": "headed-native",
});

export const NON_FRONTMOST_EVIDENCE_TIERS = Object.freeze([
  "deterministic",
  "artifact",
  "metadata-only",
  "canonical-live",
  "headed-native",
]);

export function evidenceFromPreflight(preflight) {
  const evidenceTier = evidenceTierByMode[preflight?.mode];
  if (!evidenceTier) {
    throw new Error(`INVALID_EVIDENCE_PREFLIGHT: unsupported mode ${preflight?.mode ?? "unknown"}`);
  }
  if (typeof preflight.backend !== "string" || !preflight.backend) {
    throw new Error("INVALID_EVIDENCE_PREFLIGHT: provider backend is required");
  }
  return {
    evidenceTier,
    provider: preflight.backend,
    documentMode: preflight.documentMode,
    processMode: preflight.processMode,
  };
}
