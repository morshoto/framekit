export type TimelineReadbackRoute = "session" | "fast-observation" | "canonical-resync";

export interface TimelineReadbackRequest {
  hasCanonicalBase: boolean;
  requestedCanonical: boolean;
  finalVerification: boolean;
  sessionState: "clean" | "dirty" | "possibly_stale" | "conflicted";
  fastObservation?: {
    available: boolean;
    coverageComplete: boolean;
    status: "unchanged" | "advanced-by-framekit" | "possibly-stale" | "conflicted" | "unavailable";
  };
}

export interface TimelineReadbackDecision {
  route: TimelineReadbackRoute;
  reason: string;
}

export function chooseTimelineReadback(request: TimelineReadbackRequest): TimelineReadbackDecision {
  if (!request.hasCanonicalBase) return { route: "canonical-resync", reason: "no target-bound canonical base is available" };
  if (request.requestedCanonical || request.finalVerification) return { route: "canonical-resync", reason: "the caller requires a canonical checkpoint" };
  if (request.sessionState === "possibly_stale" || request.sessionState === "conflicted") {
    return { route: "canonical-resync", reason: "the editing session requires canonical resync" };
  }
  const fast = request.fastObservation;
  if (fast?.available && (!fast.coverageComplete || fast.status === "possibly-stale")) {
    return { route: "canonical-resync", reason: "fast observation is incomplete or stale" };
  }
  if (fast?.available && fast.status === "conflicted") return { route: "canonical-resync", reason: "fast observation reported a conflict" };
  if (fast?.available && fast.coverageComplete
    && (fast.status === "unchanged" || fast.status === "advanced-by-framekit")) {
    return { route: "fast-observation", reason: "fast observation is complete and reconciled" };
  }
  return { route: "session", reason: "the bound session remains usable without a fresh observation" };
}
