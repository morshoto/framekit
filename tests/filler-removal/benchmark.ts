import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type ContextRevision,
  type EditOperation,
  type ProjectSnapshot,
  type SpeechAnalysis,
  type SpeechAnalyzer,
  type SpeechWord,
  type TimeRange,
} from "@framekit/runtime";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";

export const FILLER_REMOVAL_VERIFICATION_THRESHOLD = 0.95;
export const FILLER_REMOVAL_BENCHMARK_SCHEMA_VERSION = 1;

export type FillerRemovalScenarioCategory = "success" | "boundary" | "rollback";
export type FillerRemovalExpectedOutcome = "verified" | "rolled-back";
export type FillerRemovalActualOutcome = FillerRemovalExpectedOutcome | "failed";
export type FillerRemovalFailureCategory = "boundary" | "rollback" | "planning" | "execution" | "verification";

export interface FillerRemovalTarget {
  text: string;
  start: number;
  end: number;
}

export interface FillerRemovalScenario {
  id: string;
  category: FillerRemovalScenarioCategory;
  description: string;
  mediaId: string;
  target: FillerRemovalTarget;
  range: TimeRange;
  expectedOutcome: FillerRemovalExpectedOutcome;
  expectedTranscript: string[];
  fixture: InMemoryFixture;
}

export interface FillerRemovalCorpus {
  schemaVersion: number;
  corpusVersion: string;
  runtimeContract: string;
  config: {
    fillerConfidenceMinimum: number;
    verificationPolicy: {
      requireExpectedChange: boolean;
      requireSpeechContinuity: boolean;
    };
    verificationThreshold: number;
  };
  scenarios: FillerRemovalScenario[];
}

export interface FillerRemovalWorkflowEvidence {
  planned: boolean;
  edited: boolean;
  reObserved: boolean;
  transcriptVerified: boolean;
}

export interface FillerRemovalFailure {
  category: FillerRemovalFailureCategory;
  detail: string;
}

export interface FillerRemovalRawResult {
  scenarioId: string;
  category: FillerRemovalScenarioCategory;
  expectedOutcome: FillerRemovalExpectedOutcome;
  actualOutcome: FillerRemovalActualOutcome;
  passed: boolean;
  workflow: FillerRemovalWorkflowEvidence;
  failure?: FillerRemovalFailure;
}

export interface FillerRemovalScenarioResult extends FillerRemovalRawResult {
  beforeRevision: ContextRevision;
  afterRevision: ContextRevision;
  beforeDigest: string;
  afterDigest: string;
  plannedOperation?: EditOperation;
  transcriptBefore: string[];
  transcriptAfter: string[];
}

export interface FillerRemovalSummary {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  verificationEligible: number;
  successfulVerifications: number;
  verificationSuccessRate: number;
  failureCategories: Record<FillerRemovalFailureCategory, number>;
  threshold: {
    minimum: number;
    passed: boolean;
  };
}

export interface FillerRemovalBenchmarkReport {
  schemaVersion: number;
  metric: "successful-verification-rate";
  corpusVersion: string;
  corpusDigest: string;
  generatedAt: string;
  runtime: {
    name: string;
    version: string;
    backend: string;
    nodeVersion: string;
  };
  configuration: FillerRemovalCorpus["config"];
  scenarios: FillerRemovalScenarioResult[];
  summary: FillerRemovalSummary;
}

export interface RunFillerRemovalBenchmarkOptions {
  generatedAt?: string;
}

const corpusPath = fileURLToPath(new URL("./corpus.json", import.meta.url));

export function loadFillerRemovalCorpus(): FillerRemovalCorpus {
  const parsed: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
  assertCorpus(parsed);
  return parsed;
}

export async function runFillerRemovalBenchmark(
  options: RunFillerRemovalBenchmarkOptions = {},
): Promise<FillerRemovalBenchmarkReport> {
  const corpus = loadFillerRemovalCorpus();
  const results: FillerRemovalScenarioResult[] = [];
  let runtimeIdentity: FillerRemovalBenchmarkReport["runtime"] | undefined;

  for (const scenario of corpus.scenarios) {
    const result = await runScenario(scenario, corpus.config);
    results.push(result);
    if (!runtimeIdentity) {
      runtimeIdentity = {
        ...(await new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture)).inspectEditor()).identity,
        nodeVersion: process.version,
      };
    }
  }

  return {
    schemaVersion: FILLER_REMOVAL_BENCHMARK_SCHEMA_VERSION,
    metric: "successful-verification-rate",
    corpusVersion: corpus.corpusVersion,
    corpusDigest: createHash("sha256").update(readFileSync(corpusPath)).digest("hex"),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    runtime: runtimeIdentity!,
    configuration: structuredClone(corpus.config),
    scenarios: results,
    summary: summarizeFillerRemovalResults(results),
  };
}

export function renderFillerRemovalReport(report: FillerRemovalBenchmarkReport): string {
  const categories = Object.entries(report.summary.failureCategories)
    .map(([category, count]) => `${category}=${count}`)
    .join(" ");
  return [
    "Filler-removal benchmark",
    `corpus_version=${report.corpusVersion}`,
    `metric=${report.metric}`,
    `verification_success_rate=${formatPercent(report.summary.verificationSuccessRate)}`,
    `threshold=${formatPercent(report.summary.threshold.minimum)} threshold_passed=${report.summary.threshold.passed}`,
    `scenarios=${report.summary.totalScenarios} passed=${report.summary.passedScenarios} failed=${report.summary.failedScenarios}`,
    `failure_categories=${categories}`,
  ].join("\n");
}

export function summarizeFillerRemovalResults(results: FillerRemovalRawResult[]): FillerRemovalSummary {
  const failureCategories: Record<FillerRemovalFailureCategory, number> = {
    boundary: 0,
    rollback: 0,
    planning: 0,
    execution: 0,
    verification: 0,
  };
  for (const result of results) {
    const failure = fallbackFailure(result);
    if (failure) failureCategories[failure.category] += 1;
  }

  const verificationResults = results.filter((result) => result.expectedOutcome === "verified");
  const successfulVerifications = verificationResults.filter(
    (result) => result.passed && result.actualOutcome === "verified",
  ).length;
  const verificationSuccessRate = verificationResults.length === 0
    ? 0
    : successfulVerifications / verificationResults.length;

  return {
    totalScenarios: results.length,
    passedScenarios: results.filter((result) => result.passed).length,
    failedScenarios: results.filter((result) => !result.passed).length,
    verificationEligible: verificationResults.length,
    successfulVerifications,
    verificationSuccessRate,
    failureCategories,
    threshold: {
      minimum: FILLER_REMOVAL_VERIFICATION_THRESHOLD,
      passed: verificationSuccessRate >= FILLER_REMOVAL_VERIFICATION_THRESHOLD,
    },
  };
}

async function runScenario(
  scenario: FillerRemovalScenario,
  config: FillerRemovalCorpus["config"],
): Promise<FillerRemovalScenarioResult> {
  const workflow: FillerRemovalWorkflowEvidence = {
    planned: false,
    edited: false,
    reObserved: false,
    transcriptVerified: false,
  };
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture), {
    speechAnalyzer: createScenarioSpeechAnalyzer(scenario),
    ...(scenario.category === "rollback" ? {
      verificationEngine: {
        verify: async () => ({
          passed: false,
          checks: [{ name: "controlled-rollback", passed: false, detail: "controlled rollback fixture" }],
        }),
      },
    } : {}),
  });
  const before = await runtime.inspectProject();
  const transcriptBefore = (await runtime.analyzeSpeech(scenario.mediaId)).words.map((word) => word.text);
  const beforeDigest = canonicalSnapshotDigest(before);
  let plannedOperation: EditOperation | undefined;
  let after = before;
  let transcriptAfter = transcriptBefore;
  let actualOutcome: FillerRemovalActualOutcome = "failed";
  let failure: FillerRemovalFailure | undefined;

  try {
    plannedOperation = await planFillerRemoval(runtime, scenario, before, config);
    workflow.planned = true;
    workflow.edited = true;
    const transaction = await runtime.edit(plannedOperation, config.verificationPolicy);
    actualOutcome = transaction.status === "VERIFIED"
      ? "verified"
      : transaction.status === "ROLLED_BACK" ? "rolled-back" : "failed";
    const failedChecks = transaction.verification?.checks.filter((check) => !check.passed) ?? [];
    if (failedChecks.length > 0) {
      failure = {
        category: scenario.category === "success" ? "verification" : scenario.category,
        detail: failedChecks.map((check) => `${check.name}: ${check.detail}`).join("; "),
      };
    }
    after = await runtime.inspectProject();
    workflow.reObserved = true;
    transcriptAfter = (await runtime.analyzeSpeech(scenario.mediaId)).words.map((word) => word.text);
    workflow.transcriptVerified = transcriptMatches(scenario.expectedTranscript, transcriptAfter);
  } catch (error) {
    failure = {
      category: scenario.category === "success" ? classifyError(error) : scenario.category,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const afterDigest = canonicalSnapshotDigest(after);
  const passed = actualOutcome === scenario.expectedOutcome
    && workflow.planned
    && workflow.edited
    && workflow.reObserved
    && workflow.transcriptVerified
    && (scenario.expectedOutcome === "verified" ? afterDigest !== beforeDigest : afterDigest === beforeDigest);
  if (!failure) {
    failure = fallbackFailure({ category: scenario.category, passed, failure });
  }

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    expectedOutcome: scenario.expectedOutcome,
    actualOutcome,
    passed,
    workflow,
    ...(failure ? { failure } : {}),
    beforeRevision: before.revision,
    afterRevision: after.revision,
    beforeDigest,
    afterDigest,
    ...(plannedOperation ? { plannedOperation } : {}),
    transcriptBefore,
    transcriptAfter,
  };
}

function fallbackFailure(
  result: Pick<FillerRemovalRawResult, "category" | "passed" | "failure">,
): FillerRemovalFailure | undefined {
  if (result.passed || result.failure) return result.failure;
  return {
    category: result.category === "success" ? "verification" : result.category,
    detail: "benchmark postcondition did not hold",
  };
}

async function planFillerRemoval(
  runtime: AgentVideoRuntime,
  scenario: FillerRemovalScenario,
  before: ProjectSnapshot,
  config: FillerRemovalCorpus["config"],
): Promise<EditOperation> {
  const speech = await runtime.analyzeSpeech(scenario.mediaId);
  const target = speech.words.find((word) => word.filler
    && word.text === scenario.target.text
    && word.start === scenario.target.start
    && word.end === scenario.target.end
    && word.confidence >= config.fillerConfidenceMinimum);
  if (!target) throw new Error(`FILLER_NOT_FOUND: ${scenario.id}`);
  return {
    type: "ripple-delete",
    timelineId: before.timeline.id,
    range: structuredClone(scenario.range),
    reason: `remove filler ${target.text}`,
    baseRevision: before.revision,
  };
}

function createScenarioSpeechAnalyzer(scenario: FillerRemovalScenario): SpeechAnalyzer {
  const originalWords = scenario.fixture.media?.find((media) => media.mediaId === scenario.mediaId)?.speech?.words ?? [];
  const originalDuration = scenario.fixture.clips.reduce(
    (duration, clip) => Math.max(duration, clip.start + clip.duration),
    0,
  );
  return {
    analyze: async (input, range) => {
      const editApplied = input.project.timeline.duration < originalDuration;
      const words = editApplied && scenario.category === "success"
        ? originalWords.flatMap((word) => mapWordAfterDelete(word, scenario.range))
        : originalWords.map((word) => ({ ...word }));
      return { words: range ? words.filter((word) => overlaps(word, range)) : words };
    },
  };
}

function mapWordAfterDelete(word: SpeechWord, range: TimeRange): SpeechWord[] {
  const removedDuration = range.end - range.start;
  if (word.end <= range.start) return [{ ...word }];
  if (word.start >= range.end) {
    return [{ ...word, start: word.start - removedDuration, end: word.end - removedDuration }];
  }
  return [];
}

function overlaps(word: SpeechWord, range: TimeRange): boolean {
  return word.end > range.start && word.start < range.end;
}

function transcriptMatches(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((word, index) => actual[index] === word);
}

function classifyError(error: unknown): FillerRemovalFailureCategory {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("FILLER_") ? "planning" : "execution";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function assertCorpus(value: unknown): asserts value is FillerRemovalCorpus {
  assert.ok(value && typeof value === "object", "filler-removal corpus must be an object");
  const corpus = value as Partial<FillerRemovalCorpus>;
  assert.equal(corpus.schemaVersion, FILLER_REMOVAL_BENCHMARK_SCHEMA_VERSION, "unsupported filler-removal corpus schema");
  assert.equal(typeof corpus.corpusVersion, "string", "filler-removal corpus version is required");
  assert.equal(typeof corpus.runtimeContract, "string", "filler-removal runtime contract is required");
  assert.ok(corpus.config && typeof corpus.config === "object", "filler-removal benchmark config is required");
  assert.equal(corpus.config?.verificationThreshold, FILLER_REMOVAL_VERIFICATION_THRESHOLD, "benchmark threshold must match PRD target");
  assert.ok(Array.isArray(corpus.scenarios) && corpus.scenarios.length > 0, "filler-removal scenarios are required");
  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario && typeof scenario === "object", "filler-removal scenario must be an object");
    assert.equal(typeof scenario.id, "string", "filler-removal scenario id is required");
    assert.equal(ids.has(scenario.id), false, `duplicate filler-removal scenario: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(["success", "boundary", "rollback"].includes(scenario.category), `${scenario.id}: invalid scenario category`);
    assert.ok(scenario.fixture && typeof scenario.fixture === "object", `${scenario.id}: fixture is required`);
    assert.ok(scenario.target && scenario.target.end > scenario.target.start, `${scenario.id}: target is invalid`);
    assert.ok(scenario.range && scenario.range.end > scenario.range.start, `${scenario.id}: range is invalid`);
    assert.ok(scenario.expectedTranscript.length > 0, `${scenario.id}: expected transcript is required`);
  }
}
