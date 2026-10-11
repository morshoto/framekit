export interface CleanMcpEvidence {
  schemaVersion: 1;
  evidenceType: "clean-mcp-client-workflow";
  passed: true;
  recordedAt: string;
  environment: Record<string, string | boolean> & { gitCommit: string; sourceClean: boolean };
  framekit: { version: string };
  runtime: { version: string };
  clients: Array<{
    name: "Codex" | "Claude Code";
    clientVersion: string;
    registration: {
      status: "passed";
      command: string;
      publicPackage?: {
        status: "passed" | "blocked" | "mismatched";
        version?: string;
        commit?: string;
        reason?: string;
      };
      plugin?: { version: string; commit: string };
      packageSource?: "published-package" | "packed-source";
    };
    server: {
      version: string;
      protocolVersion: string;
      buildFingerprint?: { version: string; commit: string };
      buildFingerprintIssue?: string;
    };
    editor: { name: string; version: string; backend: string };
    capabilities: { editor: Record<string, unknown>; analyzers: Record<string, unknown> };
    workflow: {
      status: "passed";
      tools: Array<{ name: string; status: string }>;
      limitations: string[];
      delivery?: {
        processMode: "headed" | "headless" | "unknown";
        headless: { status: "passed"; backend: string; requiredCapabilities: string[] };
        nativeFinalCut: { status: "passed" | "blocked"; reason: string };
      };
    };
  }>;
  releaseCandidate?: {
    schemaVersion: 1;
    evidenceType: "framekit-release-candidate";
    target: { version: string; commit: string; sourceClean: boolean };
    status: "GO" | "NO_GO";
    artifacts: Record<string, { status: "GO" | "NO_GO"; version?: string; commit?: string; reason?: string }>;
  };
  sanitization: { strategy: string; omitted: string[] };
}

export interface CleanMcpEvidenceOptions {
  expectedClientNames?: Array<"Codex" | "Claude Code">;
}

export function sanitizeCleanMcpEvidence(run: unknown, options?: CleanMcpEvidenceOptions): CleanMcpEvidence;
