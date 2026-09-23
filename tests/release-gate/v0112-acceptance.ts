import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  createTimelineTarget,
  type ContextRevision,
} from "@framekit/runtime";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";
import { runReleaseGate, type ReleaseGateReport } from "./runner.js";

export const V0112_ACCEPTANCE_SCHEMA_VERSION = 1;
export const V0112_FILLER_VERIFICATION_THRESHOLD = 0.95;

type AcceptanceFamily = "filler-removal" | "dialogue-normalization";
type AcceptanceOutcome = "verified" | "skipped" | "rolled-back";
type EvidenceStatus = "verified" | "failed" | "unsupported" | "unrun";

interface AcceptanceProjectPolicy {
  disposable: boolean;
  privateMediaAllowed: boolean;
  headedConsentRequired: boolean;
}

interface AcceptanceScenario {
  id: string;
  family: AcceptanceFamily;
  sourceScenario: string;
  expectedOutcome: AcceptanceOutcome;
}

export interface V0112AcceptanceCorpus {
  schemaVersion: number;
  releaseVersion: "0.1.12";
  corpusVersion: string;
  runtimeContract: "v0.1.12";
  projectPolicy: AcceptanceProjectPolicy;
  thresholds: { fillerVerificationRate: number };
  negativeCases: string[];
  scenarios: AcceptanceScenario[];
}

export interface V0112ScenarioResult {
  id: string;
  family: AcceptanceFamily;
  expectedOutcome: AcceptanceOutcome;
  actualOutcome: string;
  evidenceTier: "deterministic";
  passed: boolean;
  sourceRevision: string;
  beforeDigest: string;
  afterDigest: string;
  recovery: "not-required" | "restored" | "recovery-required";
  verificationChecks?: Array<{ name: string; passed: boolean; observed?: unknown }>;
  reason?: string;
}

export interface V0112NegativeCaseResult {
  id: string;
  evidenceTier: "deterministic";
  passed: boolean;
  sourceRevision: string;
  state: "unchanged" | "restored" | "recovery-required";
  reason?: string;
}

export interface V0112TierResult {
  status: EvidenceStatus;
  attempted: boolean;
  passed: boolean;
  workflowCount: number;
  reason?: string;
}

export interface V0112AcceptanceReport {
  schemaVersion: 1;
  releaseVersion: "0.1.12";
  runtimeContract: "v0.1.12";
  corpusVersion: string;
  corpusDigest: string;
  generatedAt: string;
  projectPolicy: AcceptanceProjectPolicy;
  deterministic: {
    passed: boolean;
    fillerVerificationRate: number;
    fillerVerificationThreshold: number;
    scenarioCount: number;
    negativeCaseCount: number;
  };
  results: V0112ScenarioResult[];
  negativeCases: V0112NegativeCaseResult[];
  canonicalLive: V0112TierResult;
  headedNative: V0112TierResult;
}

interface RunV0112AcceptanceOptions {
  generatedAt?: string;
  headedEvidenceDirectory?: string;
}

const corpusPath = fileURLToPath(new URL("./v0112-acceptance.json", import.meta.url));

export function loadV0112AcceptanceCorpus(): V0112AcceptanceCorpus {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as V0112AcceptanceCorpus;
  assert.equal(corpus.schemaVersion, V0112_ACCEPTANCE_SCHEMA_VERSION, "unsupported v0.1.12 acceptance schema");
  assert.equal(corpus.releaseVersion, "0.1.12");
  assert.equal(corpus.runtimeContract, "v0.1.12");
  assert.equal(corpus.projectPolicy.disposable, true, "acceptance project must be disposable");
  assert.equal(corpus.projectPolicy.privateMediaAllowed, false, "private media is not allowed");
  assert.equal(corpus.projectPolicy.headedConsentRequired, true, "headed consent is required");
  assert.equal(corpus.thresholds.fillerVerificationRate, V0112_FILLER_VERIFICATION_THRESHOLD);
  assert.ok(Array.isArray(corpus.scenarios) && corpus.scenarios.length > 0, "acceptance scenarios are required");
  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    assert.equal(ids.has(scenario.id), false, `duplicate acceptance scenario ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.family === "filler-removal" || scenario.family === "dialogue-normalization");
    assert.ok(scenario.sourceScenario.length > 0);
    assert.ok(["verified", "skipped", "rolled-back"].includes(scenario.expectedOutcome));
  }
  for (const required of ["provider-unavailable", "stale-revision", "ambiguous-target", "verification-failure", "recovery"]) {
    assert.ok(corpus.negativeCases.includes(required), `missing negative case ${required}`);
  }
  return corpus;
}

export async function runV0112Acceptance(
  options: RunV0112AcceptanceOptions = {},
): Promise<V0112AcceptanceReport> {
  const corpus = loadV0112AcceptanceCorpus();
  const releaseGate = await runReleaseGate({
    generatedAt: options.generatedAt,
    headedEvidenceDirectory: options.headedEvidenceDirectory,
  });
  const results = corpus.scenarios.map((scenario) => scenarioResult(scenario, releaseGate));
  const negativeCases = [
    await runProviderUnavailableCase(),
    await runStaleRevisionCase(),
    await runAmbiguousTargetCase(),
    negativeFromScenario("verification-failure", results, "filler.verification-rollback"),
    negativeFromScenario("recovery", results, "dialogue.verification-rollback"),
  ];
  const deterministicPassed = releaseGate.deterministic.passed && negativeCases.every((result) => result.passed);
  return {
    schemaVersion: 1,
    releaseVersion: "0.1.12",
    runtimeContract: "v0.1.12",
    corpusVersion: corpus.corpusVersion,
    corpusDigest: createHash("sha256").update(readFileSync(corpusPath)).digest("hex"),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    projectPolicy: structuredClone(corpus.projectPolicy),
    deterministic: {
      passed: deterministicPassed,
      fillerVerificationRate: releaseGate.deterministic.fillerVerificationRate,
      fillerVerificationThreshold: corpus.thresholds.fillerVerificationRate,
      scenarioCount: results.length,
      negativeCaseCount: negativeCases.length,
    },
    results,
    negativeCases,
    canonicalLive: tierSummary(releaseGate, "canonical-live"),
    headedNative: tierSummary(releaseGate, "headed-native"),
  };
}

export function renderV0112AcceptanceReport(report: V0112AcceptanceReport): string {
  return [
    "Framekit v0.1.12 acceptance",
    `corpus_version=${report.corpusVersion}`,
    `deterministic_passed=${report.deterministic.passed}`,
    `filler_verification_rate=${(report.deterministic.fillerVerificationRate * 100).toFixed(1)}%`,
    `negative_cases=${report.deterministic.negativeCaseCount}`,
    `canonical_live=${report.canonicalLive.status}`,
    `headed_native=${report.headedNative.status}`,
  ].join("\n");
}

function scenarioResult(scenario: AcceptanceScenario, report: ReleaseGateReport): V0112ScenarioResult {
  const result = report.deterministic.workflows.find((workflow) => workflow.id === scenario.id);
  assert.ok(result, `release gate did not produce ${scenario.id}`);
  const recovery = scenario.expectedOutcome === "rolled-back"
    ? result.passed && result.beforeDigest === result.afterDigest ? "restored" : "recovery-required"
    : "not-required";
  return {
    id: scenario.id,
    family: scenario.family,
    expectedOutcome: scenario.expectedOutcome,
    actualOutcome: result.actualOutcome,
    evidenceTier: "deterministic",
    passed: result.passed,
    sourceRevision: revisionLabel(result.revisions?.before),
    beforeDigest: result.beforeDigest,
    afterDigest: result.afterDigest,
    recovery,
    ...(result.final?.verificationChecks ? { verificationChecks: result.final.verificationChecks } : {}),
    ...(result.failure ? { reason: result.failure } : {}),
  };
}

function negativeFromScenario(
  id: string,
  results: V0112ScenarioResult[],
  sourceId: string,
): V0112NegativeCaseResult {
  const result = results.find((candidate) => candidate.id === sourceId);
  assert.ok(result, `negative case source ${sourceId} is missing`);
  const restored = result.passed && result.recovery === "restored";
  return {
    id,
    evidenceTier: "deterministic",
    passed: restored,
    sourceRevision: result.sourceRevision,
    state: restored ? "restored" : "recovery-required",
    ...(restored ? {} : { reason: "controlled rollback did not restore the canonical digest" }),
  };
}

async function runProviderUnavailableCase(): Promise<V0112NegativeCaseResult> {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(baseFixture("provider-unavailable")));
  runtime.registerBuiltinSkills();
  const before = await runtime.inspectProject();
  const inspection = await runtime.inspectSkillAvailability("dialogue-normalization");
  const unavailable = !inspection.availability.available
    && inspection.availability.missingRequirements.some((requirement) => requirement.name === "audioLoudness");
  const after = await runtime.inspectProject();
  return {
    id: "provider-unavailable",
    evidenceTier: "deterministic",
    passed: unavailable && canonicalSnapshotDigest(before) === canonicalSnapshotDigest(after),
    sourceRevision: revisionLabel(before.revision),
    state: "unchanged",
    ...(unavailable ? {} : { reason: "missing audio provider was not reported before mutation" }),
  };
}

async function runStaleRevisionCase(): Promise<V0112NegativeCaseResult> {
  const adapter = new InMemoryEditorAdapter(baseFixture("stale-revision"));
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const preview = await runtime.previewEdit({
    baseRevision: before.revision,
    operations: [{
      type: "add-marker",
      timelineId: before.timeline.id,
      marker: { id: "planned-marker", start: 1, duration: 0, name: "Planned" },
      baseRevision: before.revision,
    }],
  });
  await runtime.edit({
    type: "add-marker",
    timelineId: before.timeline.id,
    marker: { id: "external-marker", start: 0, duration: 0, name: "External" },
    baseRevision: before.revision,
  });
  let stale = false;
  try {
    await runtime.executeEdit(preview.previewToken);
  } catch (error) {
    stale = /STALE_CONTEXT/.test(error instanceof Error ? error.message : String(error));
  }
  const after = await runtime.inspectProject();
  const plannedMarkerPresent = after.timeline.markers.some((marker) => marker.id === "planned-marker");
  return {
    id: "stale-revision",
    evidenceTier: "deterministic",
    passed: stale && !plannedMarkerPresent,
    sourceRevision: revisionLabel(before.revision),
    state: "unchanged",
    ...(stale && !plannedMarkerPresent ? {} : { reason: "stale preview was not rejected without a partial edit" }),
  };
}

async function runAmbiguousTargetCase(): Promise<V0112NegativeCaseResult> {
  const adapter = new InMemoryEditorAdapter({
    ...baseFixture("ambiguous-target"),
    clips: [
      { id: "duplicate-occurrence", mediaId: "media", name: "Duplicate A", start: 0, duration: 2, track: 1 },
      { id: "duplicate-occurrence", mediaId: "media", name: "Duplicate B", start: 2, duration: 2, track: 1 },
    ],
  });
  const before = await adapter.readProject();
  let ambiguous = false;
  try {
    createTimelineTarget(before, { occurrenceId: "duplicate-occurrence" });
  } catch (error) {
    ambiguous = /AMBIGUOUS_TIMELINE_TARGET/.test(error instanceof Error ? error.message : String(error));
  }
  const after = await adapter.readProject();
  return {
    id: "ambiguous-target",
    evidenceTier: "deterministic",
    passed: ambiguous && canonicalSnapshotDigest(before) === canonicalSnapshotDigest(after),
    sourceRevision: revisionLabel(before.revision),
    state: "unchanged",
    ...(ambiguous ? {} : { reason: "duplicate occurrence identity was not rejected before mutation" }),
  };
}

function tierSummary(report: ReleaseGateReport, tier: "canonical-live" | "headed-native"): V0112TierResult {
  const evidence = report.evidenceTiers[tier];
  return {
    status: evidence.status,
    attempted: evidence.attempted,
    passed: evidence.passed,
    workflowCount: evidence.workflows.length,
    ...(evidence.status === "unrun" || evidence.status === "unsupported"
      ? { reason: evidence.preflight.unavailableReason ?? `${tier} evidence was not supplied` }
      : {}),
  };
}

function baseFixture(name: string): InMemoryFixture {
  return {
    projectId: `v0112-${name}`,
    projectName: "v0.1.12 Disposable Acceptance",
    timelineId: `timeline-${name}`,
    timelineName: "Acceptance",
    frameDuration: { value: "1", timescale: "30" },
    clips: [],
    media: [],
  };
}

function revisionLabel(revision: ContextRevision | undefined): string {
  return revision ? `${revision.id}@${revision.sequence}` : "unobserved";
}
