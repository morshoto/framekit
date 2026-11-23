export interface QaBuildIdentity {
  candidateCommit: string;
  candidateTree: string;
  packageDigest: string;
  mcpDigest: string;
  pluginDigest: string;
  extensionDigest: string;
}
export interface QaPreflightObservation {
  headlessPassed: boolean;
  expected: QaBuildIdentity;
  observed: QaBuildIdentity;
  console: "unlocked" | "locked" | "unknown";
  finalCut: "frontmost" | "not-frontmost" | "unknown";
  recovery: "clear" | "required" | "unavailable";
}
type Result = {
  state: "BLOCKED" | "WAITING" | "AWAITING_AUTHORIZATION";
  nextAction: "resolve-headless-failure" | "resolve-identity-mismatch" | "resolve-recovery" | "inspect-readiness" | "unlock-console" | "make-final-cut-frontmost" | "authorize-exact-operation";
  dispatchAllowed: false;
  evidence: "preflight-only";
};
const keys: Array<keyof QaBuildIdentity> = ["candidateCommit", "candidateTree", "packageDigest", "mcpDigest", "pluginDigest", "extensionDigest"];
function validIdentity(value: QaBuildIdentity | undefined): boolean {
  return !!value && keys.every(key => typeof value[key] === "string" && (key.startsWith("candidate") ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value[key]));
}
function result(state: Result["state"], nextAction: Result["nextAction"]): Result {
  return { state, nextAction, dispatchAllowed: false, evidence: "preflight-only" };
}

/** Assess supplied observations only. This does not observe Final Cut or authorize dispatch. */
export function assessQaPreflight(observation: QaPreflightObservation): Result {
  if (observation.headlessPassed !== true) return result("BLOCKED", "resolve-headless-failure");
  if (!validIdentity(observation.expected) || !validIdentity(observation.observed) || keys.some(key => observation.expected[key] !== observation.observed[key])) return result("BLOCKED", "resolve-identity-mismatch");
  if (observation.recovery !== "clear") return result("BLOCKED", "resolve-recovery");
  if (observation.console === "unknown" || observation.finalCut === "unknown") return result("BLOCKED", "inspect-readiness");
  if (observation.console === "locked") return result("WAITING", "unlock-console");
  if (observation.finalCut === "not-frontmost") return result("WAITING", "make-final-cut-frontmost");
  if (observation.console !== "unlocked" || observation.finalCut !== "frontmost") return result("BLOCKED", "inspect-readiness");
  return result("AWAITING_AUTHORIZATION", "authorize-exact-operation");
}
