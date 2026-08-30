import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type AudioAnalyzer,
  type RuntimeOptions,
  type SpeechAnalyzer,
  type ProjectSnapshot,
} from "@framekit/runtime";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const corpusPath = fileURLToPath(new URL("./corpus.json", import.meta.url));
const requiredFillerCases = [
  "obvious",
  "low-confidence",
  "unsafe-boundary",
  "overlapping-speech",
  "protected-segment",
  "multi-filler",
  "verification-rollback",
] as const;
const requiredDialogueCases = [
  "quiet",
  "loud",
  "already-normalized",
  "silent",
  "no-dialogue",
  "peak-risk",
  "gain-clamp",
  "verification-rollback",
] as const;

export type ReleaseGateFamily = "filler-removal" | "dialogue-normalization";
export type ReleaseGateOutcome = "verified" | "skipped" | "rolled-back" | "failed";

export interface ReleaseGateWorkflow {
  id: string;
  family: ReleaseGateFamily;
  scenario: string;
  expectedOutcome: Exclude<ReleaseGateOutcome, "failed">;
  fixture: { kind: "filler" | "dialogue"; case: string };
}

export interface ReleaseGateCorpus {
  schemaVersion: number;
  corpusVersion: string;
  runtimeContract: string;
  workflows: ReleaseGateWorkflow[];
}

export interface ReleaseGateWorkflowEvidence {
  id: string;
  family: ReleaseGateFamily;
  expectedOutcome: Exclude<ReleaseGateOutcome, "failed">;
  actualOutcome: ReleaseGateOutcome;
  passed: boolean;
  attempted: boolean;
  previewed: boolean;
  executed: boolean;
  reObserved: boolean;
  beforeDigest: string;
  afterDigest: string;
  preview?: unknown;
  final?: {
    status: string;
    revisionSequence: number;
    verificationPassed?: boolean;
    diff?: unknown;
  };
  failure?: string;
}

export interface ReleaseGateReport {
  schemaVersion: 1;
  gate: "v0.0.3-closed-loop-speech-editing";
  corpusVersion: string;
  generatedAt: string;
  deterministic: {
    passed: boolean;
    workflows: ReleaseGateWorkflowEvidence[];
    fillerVerificationRate: number;
    fillerVerificationThreshold: number;
  };
  adapter: {
    backend: "fixture";
    fixtureEvidence: true;
    fcpXml: { status: "unsupported"; reason: string };
  };
  live: {
    status: "unsupported";
    claimed: false;
    reason: string;
  };
  unsupportedCapabilities: string[];
}

export interface RunReleaseGateOptions {
  generatedAt?: string;
}

export function loadReleaseGateCorpus(): ReleaseGateCorpus {
  const parsed = JSON.parse(readFileSync(corpusPath, "utf8")) as ReleaseGateCorpus;
  assert.equal(parsed.schemaVersion, 1, "unsupported release gate corpus schema");
  assert.ok(parsed.corpusVersion, "release gate corpus version is required");
  assert.equal(parsed.runtimeContract, "v0.0.3");
  assert.ok(Array.isArray(parsed.workflows) && parsed.workflows.length > 0, "release gate workflows are required");
  const ids = new Set<string>();
  for (const workflow of parsed.workflows) {
    assert.equal(ids.has(workflow.id), false, `duplicate release gate workflow: ${workflow.id}`);
    ids.add(workflow.id);
    assert.ok(workflow.family === "filler-removal" || workflow.family === "dialogue-normalization");
    assert.ok(workflow.fixture && typeof workflow.fixture === "object", `${workflow.id}: fixture is required`);
  }
  for (const scenario of requiredFillerCases) {
    assert.ok(parsed.workflows.some((workflow) => workflow.family === "filler-removal" && workflow.scenario === scenario), `missing filler case ${scenario}`);
  }
  for (const scenario of requiredDialogueCases) {
    assert.ok(parsed.workflows.some((workflow) => workflow.family === "dialogue-normalization" && workflow.scenario === scenario), `missing dialogue case ${scenario}`);
  }
  return parsed;
}

export async function runReleaseGate(options: RunReleaseGateOptions = {}): Promise<ReleaseGateReport> {
  const corpus = loadReleaseGateCorpus();
  const workflows = [];
  for (const workflow of corpus.workflows) workflows.push(await runWorkflow(workflow));
  const fillerResults = workflows.filter((workflow) => workflow.family === "filler-removal"
    && workflow.expectedOutcome === "verified");
  const successfulFillers = fillerResults.filter((workflow) => workflow.passed && workflow.actualOutcome === "verified").length;
  const fillerVerificationRate = fillerResults.length === 0 ? 0 : successfulFillers / fillerResults.length;
  const deterministicPassed = workflows.every((workflow) => workflow.passed) && fillerVerificationRate >= 0.95;
  return {
    schemaVersion: 1,
    gate: "v0.0.3-closed-loop-speech-editing",
    corpusVersion: corpus.corpusVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    deterministic: {
      passed: deterministicPassed,
      workflows,
      fillerVerificationRate,
      fillerVerificationThreshold: 0.95,
    },
    adapter: {
      backend: "fixture",
      fixtureEvidence: true,
      fcpXml: {
        status: "unsupported",
        reason: "The current FCPXML adapter does not advertise both v0.0.3 Skill write guarantees.",
      },
    },
    live: {
      status: "unsupported",
      claimed: false,
      reason: "Opt-in headed Final Cut evidence was not requested; the bundled bridge remains metadata-only.",
    },
    unsupportedCapabilities: [
      "fcpxml filler-removal closed loop",
      "fcpxml dialogue-normalization closed loop",
      "live canonical timeline enumeration",
      "live canonical timeline mutation",
    ],
  };
}

export function renderReleaseGateReport(report: ReleaseGateReport): string {
  return [
    "Framekit v0.0.3 closed-loop speech editing release gate",
    `corpus_version=${report.corpusVersion}`,
    `deterministic_passed=${report.deterministic.passed}`,
    `workflows=${report.deterministic.workflows.length}`,
    `filler_verification_rate=${(report.deterministic.fillerVerificationRate * 100).toFixed(1)}%`,
    `adapter_backend=${report.adapter.backend}`,
    `live_status=${report.live.status}`,
  ].join("\n");
}

async function runWorkflow(workflow: ReleaseGateWorkflow): Promise<ReleaseGateWorkflowEvidence> {
  const { runtime, adapter, skillArguments } = createWorkflowRuntime(workflow);
  const server = createMcpServer(runtime);
  const client = new Client({ name: "framekit-release-gate", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let before: ProjectSnapshot | undefined;
  let after: ProjectSnapshot | undefined;
  let previewEvidence: unknown;
  let finalEvidence: ReleaseGateWorkflowEvidence["final"];
  let actualOutcome: ReleaseGateOutcome = "failed";
  let failure: string | undefined;
  let previewed = false;
  let executed = false;

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const skills = parseJson(await client.callTool({ name: "skill.list", arguments: {} })) as Array<{ id: string }>;
    assert.deepEqual(skills.map((skill) => skill.id), ["filler-removal", "dialogue-normalization"]);
    before = parseJson(await client.callTool({ name: "project.inspect", arguments: {} })) as ProjectSnapshot;
    previewed = true;
    const previewResult = await client.callTool({
      name: "skill.preview",
      arguments: { skill: workflow.family, arguments: { ...skillArguments, baseRevision: before.revision } },
    });
    if (previewResult.isError) throw new Error(parseToolError(previewResult));
    const preview = parseJson(previewResult) as Record<string, any>;
    previewEvidence = sanitizePreview(preview);

    if (workflow.family === "dialogue-normalization") {
      const decision = preview.plan?.decision;
      if (decision === "SKIP") {
        actualOutcome = "skipped";
      } else if (decision === "NO_OP") {
        actualOutcome = "verified";
      } else {
        const token = preview.previewToken;
        assert.equal(typeof token, "string", `${workflow.id}: APPLY preview has no token`);
        executed = true;
        const result = await client.callTool({
          name: "skill.execute",
          arguments: { skill: workflow.family, previewToken: token },
        });
        if (result.isError) throw new Error(parseToolError(result));
        const transaction = parseJson(result) as Record<string, any>;
        actualOutcome = transaction.status === "VERIFIED" ? "verified"
          : transaction.status === "ROLLED_BACK" ? "rolled-back" : "failed";
        finalEvidence = sanitizeTransaction(transaction);
      }
    } else {
      const token = preview.previewToken;
      assert.equal(typeof token, "string", `${workflow.id}: filler preview has no token`);
      executed = true;
      const result = await client.callTool({
        name: "skill.execute",
        arguments: { skill: workflow.family, previewToken: token },
      });
      if (result.isError) throw new Error(parseToolError(result));
      const transaction = parseJson(result) as Record<string, any>;
      actualOutcome = transaction.status === "VERIFIED" ? "verified"
        : transaction.status === "ROLLED_BACK" ? "rolled-back" : "failed";
      finalEvidence = sanitizeTransaction(transaction);
    }
    after = parseJson(await client.callTool({ name: "project.inspect", arguments: {} })) as ProjectSnapshot;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (workflow.expectedOutcome === "skipped" && isExpectedSkipFailure(failure)) actualOutcome = "skipped";
    try {
      after = parseJson(await client.callTool({ name: "project.inspect", arguments: {} })) as ProjectSnapshot;
    } catch {
      after = before;
    }
  } finally {
    await client.close();
    await server.close();
  }

  const beforeDigest = before ? canonicalSnapshotDigest(before) : "";
  const afterDigest = after ? canonicalSnapshotDigest(after) : "";
  const unchanged = beforeDigest !== "" && beforeDigest === afterDigest;
  const passed = actualOutcome === workflow.expectedOutcome
    && (workflow.expectedOutcome === "verified" && workflow.scenario !== "already-normalized"
      ? beforeDigest !== afterDigest
      : workflow.expectedOutcome !== "verified" ? unchanged : true);
  return {
    id: workflow.id,
    family: workflow.family,
    expectedOutcome: workflow.expectedOutcome,
    actualOutcome,
    passed,
    attempted: true,
    previewed,
    executed,
    reObserved: after !== undefined,
    beforeDigest,
    afterDigest,
    ...(previewEvidence !== undefined ? { preview: previewEvidence } : {}),
    ...(finalEvidence ? { final: finalEvidence } : {}),
    ...(!passed ? { failure: failure ?? "release gate postcondition failed" } : {}),
  };
}

function createWorkflowRuntime(workflow: ReleaseGateWorkflow): {
  runtime: AgentVideoRuntime;
  adapter: InMemoryEditorAdapter;
  skillArguments: Record<string, unknown>;
} {
  const fixture = workflow.family === "filler-removal"
    ? createFillerFixture(workflow.scenario)
    : createDialogueFixture(workflow.scenario);
  const adapter = new InMemoryEditorAdapter(fixture);
  const options: RuntimeOptions = {
    ...(workflow.family === "filler-removal" ? { speechAnalyzer: createFillerAnalyzer(workflow.scenario) } : {}),
    ...(workflow.family === "dialogue-normalization" ? { audioAnalyzer: createDialogueAnalyzer(workflow.scenario) } : {}),
    ...(workflow.scenario === "verification-rollback" ? {
      verificationEngine: {
        verify: async () => ({
          passed: false,
          checks: [{ name: "controlled-release-gate-failure", passed: false, detail: "controlled rollback fixture" }],
        }),
      },
    } : {}),
  };
  return {
    runtime: new AgentVideoRuntime(adapter, options),
    adapter,
    skillArguments: workflow.family === "filler-removal"
      ? { range: { start: 0, end: 6 } }
      : {
        mediaId: "dialogue-media",
        occurrenceId: "dialogue-clip",
        targetLufs: -16,
        toleranceDb: 0.5,
        maxTruePeakDb: -1,
        minGainDb: -6,
        maxGainDb: 6,
        minDialogueDurationSeconds: 1,
      },
  };
}

function createFillerFixture(scenario: string): InMemoryFixture {
  const words = fillerWords(scenario);
  return {
    projectId: `release-${scenario}`,
    projectName: "v0.0.3 Release Gate",
    timelineId: `timeline-${scenario}`,
    timelineName: scenario,
    clips: [{ id: "filler-clip", mediaId: "filler-media", name: "Speech", start: 0, duration: 6, track: 1 }],
    media: [{
      mediaId: "filler-media",
      source: `fixtures/release-${scenario}.wav`,
      mediaKind: "video",
      duration: 6,
      speech: { words },
    }],
  };
}

function fillerWords(scenario: string) {
  if (scenario === "low-confidence") {
    return [
      { text: "so", start: 0, end: 0.3, confidence: 0.99 },
      { text: "um", start: 0.6, end: 0.9, confidence: 0.8, filler: true },
      { text: "what", start: 1, end: 1.4, confidence: 0.99 },
    ];
  }
  if (["unsafe-boundary", "overlapping-speech", "protected-segment"].includes(scenario)) {
    return [
      { text: "so", start: 0, end: 0.3, confidence: 0.99 },
      { text: "um", start: 1, end: 1.4, confidence: 0.98, filler: true },
      { text: "what", start: 1.3, end: 1.8, confidence: 0.99 },
    ];
  }
  if (scenario === "multi-filler") {
    return [
      { text: "so", start: 0, end: 0.3, confidence: 0.99 },
      { text: "um", start: 0.6, end: 0.9, confidence: 0.98, filler: true },
      { text: "we", start: 1, end: 1.4, confidence: 0.99 },
      { text: "uh", start: 2, end: 2.3, confidence: 0.98, filler: true },
      { text: "decided", start: 2.4, end: 3, confidence: 0.99 },
    ];
  }
  return [
    { text: "so", start: 0, end: 0.3, confidence: 0.99 },
    { text: "um", start: 0.6, end: 0.9, confidence: 0.98, filler: true },
    { text: "what", start: 1, end: 1.4, confidence: 0.99 },
  ];
}

function createFillerAnalyzer(scenario: string): SpeechAnalyzer {
  const originalWords = fillerWords(scenario);
  return {
    analyze: async ({ project }) => {
      const clip = project.timeline.clips.find((candidate) => candidate.id === "filler-clip");
      if ((clip?.duration ?? 6) >= 6 || !["obvious", "multi-filler", "verification-rollback"].includes(scenario)) {
        return { words: structuredClone(originalWords) };
      }
      const removals = originalWords.filter((word) => word.filler === true);
      return {
        words: originalWords.flatMap((word) => {
          if (word.filler) return [];
          const shift = removals
            .filter((removal) => removal.end <= word.start)
            .reduce((total, removal) => total + removal.end - removal.start, 0);
          return [{ ...word, start: word.start - shift, end: word.end - shift }];
        }),
      };
    },
  };
}

function createDialogueFixture(scenario: string): InMemoryFixture {
  const audio = dialogueAudio(scenario);
  return {
    projectId: `release-dialogue-${scenario}`,
    projectName: "v0.0.3 Release Gate",
    timelineId: `timeline-dialogue-${scenario}`,
    timelineName: scenario,
    clips: [{ id: "dialogue-clip", mediaId: "dialogue-media", name: "Dialogue", start: 0, duration: 10, track: 1 }],
    media: [{
      mediaId: "dialogue-media",
      source: `fixtures/release-dialogue-${scenario}.wav`,
      mediaKind: "video",
      duration: 10,
      speech: { words: scenario === "no-dialogue" ? [] : [{ text: "hello", start: 0, end: 2, confidence: 0.99 }] },
      audio,
    }],
  };
}

function dialogueAudio(scenario: string) {
  const values = {
    quiet: { integratedLufs: -20, truePeakDb: -6, silenceMs: 100, dialoguePresent: true },
    loud: { integratedLufs: -12, truePeakDb: -6, silenceMs: 100, dialoguePresent: true },
    "already-normalized": { integratedLufs: -16, truePeakDb: -3, silenceMs: 100, dialoguePresent: true },
    silent: { integratedLufs: -20, truePeakDb: -6, silenceMs: 10_000, dialoguePresent: true },
    "no-dialogue": { integratedLufs: -20, truePeakDb: -6, silenceMs: 100, dialoguePresent: false },
    "peak-risk": { integratedLufs: -20, truePeakDb: -2, silenceMs: 100, dialoguePresent: true },
    "gain-clamp": { integratedLufs: -30, truePeakDb: -6, silenceMs: 100, dialoguePresent: true },
    "verification-rollback": { integratedLufs: -20, truePeakDb: -6, silenceMs: 100, dialoguePresent: true },
  } as const;
  return values[scenario as keyof typeof values];
}

function createDialogueAnalyzer(scenario: string): AudioAnalyzer {
  const original = dialogueAudio(scenario);
  return {
    analyze: async ({ project }) => {
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-clip")?.gainDb ?? 0;
      return {
        ...original,
        integratedLufs: original.integratedLufs + gain,
        truePeakDb: original.truePeakDb + gain,
        analyzedDurationSeconds: 10,
      };
    },
  };
}

function parseJson(value: unknown): unknown {
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  return JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "null");
}

function parseToolError(value: unknown): string {
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  return result.content?.map((item) => item.text).filter(Boolean).join(" ") ?? "MCP tool failed";
}

function sanitizePreview(preview: Record<string, any>): unknown {
  const { previewToken: _previewToken, expiresAt: _expiresAt, ...stable } = preview;
  return stable;
}

function sanitizeTransaction(transaction: Record<string, any>): ReleaseGateWorkflowEvidence["final"] {
  return {
    status: transaction.status,
    revisionSequence: transaction.after?.revision?.sequence ?? -1,
    verificationPassed: transaction.verification?.passed,
    diff: transaction.diff,
  };
}

function isExpectedSkipFailure(message: string): boolean {
  return /NO_FILLERS_FOUND|ANALYSIS_INVALID|CAPABILITY_UNAVAILABLE/.test(message);
}
