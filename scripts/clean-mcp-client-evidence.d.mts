export interface CleanMcpEvidence {
  schemaVersion: 1;
  evidenceType: "clean-mcp-client-workflow";
  passed: true;
  recordedAt: string;
  environment: Record<string, string>;
  framekit: { version: string };
  runtime: { version: string };
  clients: Array<{
    name: "Codex" | "Claude Code";
    clientVersion: string;
    registration: { status: "passed"; command: string; publicPackage?: { status: "passed" | "blocked"; reason?: string } };
    server: { version: string; protocolVersion: string };
    editor: { name: string; version: string; backend: string };
    capabilities: { editor: Record<string, unknown>; analyzers: Record<string, unknown> };
    workflow: {
      status: "passed";
      tools: Array<{ name: string; status: string }>;
      limitations: string[];
    };
  }>;
  sanitization: { strategy: string; omitted: string[] };
}

export interface CleanMcpEvidenceOptions {
  expectedClientNames?: Array<"Codex" | "Claude Code">;
}

export function sanitizeCleanMcpEvidence(run: unknown, options?: CleanMcpEvidenceOptions): CleanMcpEvidence;
