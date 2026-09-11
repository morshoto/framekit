import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  createCapabilityPreflight,
  withCapabilityFamilies,
  type AudioAnalyzer,
  type RuntimeOptions,
  type SpeechAnalyzer,
  type ProjectSnapshot,
  type WorkflowOperation,
} from "@framekit/runtime";
import { FcpxmlDocumentAdapter, FinalCutSessionAdapter } from "@framekit/final-cut";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { FRAMEKIT_VERSION } from "../../apps/mcp-server/src/version.js";
import {
  assessReleaseProvenance,
  loadNativeEditingManifest,
  summarizeHeadedEvidence,
  type EvidenceMode,
  type EvidenceStatus,
  type HeadedEvidenceSummary,
  type NativeEditingManifest,
  type ReleaseProvenanceInput,
  type ReleaseProvenanceReport,
} from "./native-editing.js";
import { unrunRepositoryChecks, type RepositoryChecksReport } from "./repository-checks.js";

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
  gate: "v0.1.6-native-editing";
  manifestVersion: string;
  releaseVersion: "0.1.6";
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
  evidenceTiers: ReleaseGateEvidenceTiers;
  workflowMatrix: ReleaseGateWorkflowMatrixEntry[];
  provenance: ReleaseProvenanceReport;
  repositoryChecks: RepositoryChecksReport;
}

export interface RunReleaseGateOptions {
  generatedAt?: string;
  headedEvidenceDirectory?: string;
  provenance?: Partial<ReleaseProvenanceInput>;
  repositoryChecks?: RepositoryChecksReport;
}

export interface ReleaseGateWorkflowMatrixEntry {
  workflowId: string;
  operation: string;
    capability: string;
  evidence: Array<{
    tier: string;
    status: EvidenceStatus;
    passed: boolean;
    reason?: string;
  }>;
}

export interface ReleaseGateEvidence {
  tier: string;
  status: EvidenceStatus;
  attempted: boolean;
  passed: boolean;
  mode: EvidenceMode;
  backend: string;
  guarantee: string;
  preflight: {
    mode: EvidenceMode;
    backend: string;
    guarantee: string;
    capabilities?: unknown;
    unavailableReason?: string;
  };
  workflows: Array<{
    workflowId: string;
    status: EvidenceStatus;
    passed: boolean;
    evidenceType?: string;
    target?: HeadedEvidenceSummary["target"];
    revision?: HeadedEvidenceSummary["revision"];
    verification?: { execute: boolean; undo: boolean };
    reason?: string;
  }>;
}

export interface ReleaseGateEvidenceTiers {
  deterministic: ReleaseGateEvidence;
  "fcpxml-artifact": ReleaseGateEvidence;
  "metadata-only": ReleaseGateEvidence;
  "canonical-live": ReleaseGateEvidence;
  "headed-native": ReleaseGateEvidence;
}

export function loadReleaseGateCorpus(): ReleaseGateCorpus {
  const parsed = JSON.parse(readFileSync(corpusPath, "utf8")) as ReleaseGateCorpus;
  assert.equal(parsed.schemaVersion, 1, "unsupported release gate corpus schema");
  assert.ok(parsed.corpusVersion, "release gate corpus version is required");
  assert.equal(parsed.runtimeContract, "v0.1.6");
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
  const manifest = loadNativeEditingManifest();
  const workflows = [];
  for (const workflow of corpus.workflows) workflows.push(await runWorkflow(workflow));
  const fillerResults = workflows.filter((workflow) => workflow.family === "filler-removal"
    && workflow.expectedOutcome === "verified");
  const successfulFillers = fillerResults.filter((workflow) => workflow.passed && workflow.actualOutcome === "verified").length;
  const fillerVerificationRate = fillerResults.length === 0 ? 0 : successfulFillers / fillerResults.length;
  const deterministicPassed = workflows.every((workflow) => workflow.passed) && fillerVerificationRate >= 0.95;
  const deterministicEditing = await runDeterministicEditingWorkflows();
  const fcpxmlArtifact = await runFcpxmlArtifactWorkflows();
  const metadataOnly = await runMetadataOnlyPreflight();
  const evidenceTiers = await collectEvidenceTiers({
    manifest,
    deterministicPassed,
    deterministicWorkflows: [
      ...deterministicEditing,
      aggregateWorkflow("filler-removal", workflows),
      aggregateWorkflow("dialogue-normalization", workflows),
    ],
    fcpxmlWorkflows: fcpxmlArtifact,
    metadataOnly,
    headedEvidenceDirectory: options.headedEvidenceDirectory,
  });
  const packageManifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
  };
  const pluginManifest = JSON.parse(readFileSync(new URL("../../plugins/framekit/.codex-plugin/plugin.json", import.meta.url), "utf8")) as {
    name?: string;
    version?: string;
  };
  const provenance = assessReleaseProvenance({
    packageManifest,
    pluginManifest,
    serverVersion: FRAMEKIT_VERSION,
    ...options.provenance,
  });
  const report = {
    schemaVersion: 1,
    gate: "v0.1.6-native-editing",
    manifestVersion: manifest.manifestVersion,
    releaseVersion: manifest.releaseVersion,
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
    evidenceTiers,
    workflowMatrix: buildWorkflowMatrix(manifest, evidenceTiers),
    provenance,
    repositoryChecks: options.repositoryChecks ?? unrunRepositoryChecks(),
  } satisfies ReleaseGateReport;
  return report;
}

export function renderReleaseGateReport(report: ReleaseGateReport): string {
  return [
    "Framekit v0.1.6 native-editing release gate",
    `manifest_version=${report.manifestVersion}`,
    `corpus_version=${report.corpusVersion}`,
    `deterministic_passed=${report.deterministic.passed}`,
    `workflows=${report.deterministic.workflows.length}`,
    `filler_verification_rate=${(report.deterministic.fillerVerificationRate * 100).toFixed(1)}%`,
    `adapter_backend=${report.adapter.backend}`,
    `live_status=${report.live.status}`,
    `fcpxml_status=${report.evidenceTiers["fcpxml-artifact"].status}`,
    `metadata_only_status=${report.evidenceTiers["metadata-only"].status}`,
    `canonical_live_status=${report.evidenceTiers["canonical-live"].status}`,
    `headed_native_status=${report.evidenceTiers["headed-native"].status}`,
    `release_ready=${report.provenance.releaseReady}`,
  ].join("\n");
}

interface TierWorkflowResult {
  workflowId: string;
  status: EvidenceStatus;
  passed: boolean;
  evidenceType?: string;
  target?: HeadedEvidenceSummary["target"];
  revision?: HeadedEvidenceSummary["revision"];
  verification?: { execute: boolean; undo: boolean };
  reason?: string;
}

interface MetadataOnlyResult {
  preflight: ReleaseGateEvidence["preflight"];
  workflows: TierWorkflowResult[];
}

async function runDeterministicEditingWorkflows(): Promise<TierWorkflowResult[]> {
  return [
    await runFixtureEditingWorkflow("picture-in-picture", {
      type: "timeline.picture-in-picture.add",
      occurrenceId: "pip-occurrence",
      mediaId: "pip-media",
      attachedTo: "primary-occurrence",
      start: 2,
      duration: 4,
      targetLane: 1,
      position: { x: 320, y: -180 },
      scale: 0.35,
      crop: { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 },
    }),
    await runFixtureEditingWorkflow("built-in-title-discovery", {
      type: "timeline.title.add",
      occurrenceId: "title-occurrence",
      assetId: "title-basic",
      text: "Framekit release proof",
      start: 1,
      duration: 2,
      targetLane: 2,
    }),
    await runFixtureEditingWorkflow("masking", {
      type: "timeline.mask.add",
      occurrenceId: "primary-occurrence",
      mask: { mode: "rectangle", bounds: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 } },
    }),
  ];
}

async function runFixtureEditingWorkflow(
  workflowId: string,
  operation: WorkflowOperation,
): Promise<TierWorkflowResult> {
  const adapter = new InMemoryEditorAdapter({
    projectId: "release-gate-fixture",
    projectName: "Native Editing Release Gate",
    timelineId: "release-gate-timeline",
    timelineName: "Main Edit",
    clips: [{
      id: "primary-occurrence",
      mediaId: "primary-media",
      name: "Presenter",
      start: 0,
      duration: 10,
      track: 1,
    }],
    media: [
      { mediaId: "primary-media", source: "fixtures/presenter.mov", mediaKind: "video", duration: 10 },
      { mediaId: "pip-media", source: "fixtures/guest.mov", mediaKind: "video", duration: 6 },
    ],
    assets: [{ id: "title-basic", kind: "title", name: "Basic Title", vendor: "Framekit Fixture", metadata: {} }],
  });
  const runtime = new AgentVideoRuntime(adapter);

  try {
    if (workflowId === "built-in-title-discovery") {
      const titles = await runtime.listAssets({ kind: "title", query: "Basic Title" });
      assert.equal(titles.length, 1, "fixture title discovery must be unique");
    }
    const before = await runtime.inspectProject();
    const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: [operation] });
    const transaction = await runtime.executeEdit(preview.previewToken);
    const after = await runtime.inspectProject();
    const restored = await runtime.undo(transaction.id);
    const changed = canonicalSnapshotDigest(before) !== canonicalSnapshotDigest(after);
    const restoredOriginal = canonicalSnapshotDigest(before) === canonicalSnapshotDigest(restored);
    const verified = transaction.status === "VERIFIED" && changed && restoredOriginal;
    return {
      workflowId,
      status: verified ? "verified" : "failed",
      passed: verified,
      revision: {
        before: before.revision.id,
        after: after.revision.id,
        restored: restored.revision.id,
      },
      verification: { execute: verified, undo: restoredOriginal },
      ...(verified ? {} : { reason: "fixture edit did not verify a changed and restored canonical snapshot" }),
    };
  } catch (error) {
    return { workflowId, status: "failed", passed: false, reason: safeFailure(error) };
  }
}

async function runFcpxmlArtifactWorkflows(): Promise<TierWorkflowResult[]> {
  return [await runFcpxmlPictureInPicture(), await runFcpxmlDialogueNormalization()];
}

async function runFcpxmlPictureInPicture(): Promise<TierWorkflowResult> {
  const directory = await mkdtemp(join(tmpdir(), "framekit-release-gate-fcpxml-"));
  const artifactPath = join(directory, "pip.fcpxml");
  try {
    await writeFile(artifactPath, releaseGateFcpxml(), "utf8");
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [{
        type: "timeline.picture-in-picture.add",
        occurrenceId: "pip-occurrence",
        mediaId: "pip-media",
        attachedTo: "primary-occurrence",
        start: 2,
        duration: 4,
        targetLane: 1,
        position: { x: 320, y: -180 },
        scale: 0.35,
        crop: { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 },
      }],
    });
    const transaction = await runtime.executeEdit(preview.previewToken);
    const after = await runtime.inspectProject();
    const restored = await runtime.undo(transaction.id);
    const verified = transaction.status === "VERIFIED"
      && canonicalSnapshotDigest(before) !== canonicalSnapshotDigest(after)
      && canonicalSnapshotDigest(before) === canonicalSnapshotDigest(restored);
    return {
      workflowId: "picture-in-picture",
      status: verified ? "verified" : "failed",
      passed: verified,
      revision: { before: before.revision.id, after: after.revision.id, restored: restored.revision.id },
      verification: { execute: verified, undo: canonicalSnapshotDigest(before) === canonicalSnapshotDigest(restored) },
      ...(verified ? {} : { reason: "FCPXML PIP artifact did not verify and restore" }),
    };
  } catch (error) {
    return { workflowId: "picture-in-picture", status: "failed", passed: false, reason: safeFailure(error) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runFcpxmlDialogueNormalization(): Promise<TierWorkflowResult> {
  const directory = await mkdtemp(join(tmpdir(), "framekit-release-gate-dialogue-"));
  const artifactPath = join(directory, "dialogue.fcpxml");
  try {
    await writeFile(artifactPath, releaseGateFcpxml(), "utf8");
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath));
    const before = await runtime.inspectProject();
    const preview = await runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [{
        type: "set-gain",
        clipId: "primary-occurrence",
        gainDb: 4,
      }],
    });
    const transaction = await runtime.executeEdit(preview.previewToken);
    const after = await runtime.inspectProject();
    const restored = await runtime.undo(transaction.id);
    const verified = transaction.status === "VERIFIED"
      && canonicalSnapshotDigest(before) !== canonicalSnapshotDigest(after)
      && canonicalSnapshotDigest(before) === canonicalSnapshotDigest(restored);
    return {
      workflowId: "dialogue-normalization",
      status: verified ? "verified" : "failed",
      passed: verified,
      revision: { before: before.revision.id, after: after.revision.id, restored: restored.revision.id },
      verification: { execute: verified, undo: canonicalSnapshotDigest(before) === canonicalSnapshotDigest(restored) },
      ...(verified ? {} : { reason: "FCPXML dialogue artifact did not verify and restore" }),
    };
  } catch (error) {
    return { workflowId: "dialogue-normalization", status: "failed", passed: false, reason: safeFailure(error) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function releaseGateFcpxml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <asset id="primary-media" name="Presenter" src="file:///fixtures/presenter.mov" duration="10s" />
    <asset id="pip-media" name="Guest" src="file:///fixtures/guest.mov" duration="6s" />
  </resources>
  <library><event name="Release Gate"><project uid="release-gate-project" name="Native Editing Release Gate">
    <sequence uid="release-gate-sequence" name="Main Edit" duration="10s"><spine>
      <asset-clip id="primary-occurrence" ref="primary-media" name="Presenter" offset="0s" duration="10s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>
`;
}

async function runMetadataOnlyPreflight(): Promise<MetadataOnlyResult> {
  const metadataCapabilities = withCapabilityFamilies({
    editor: {
      projectRead: true,
      timelineSnapshotRead: false,
      timelineWrite: false,
      timelineArtifactWrite: false,
      readAfterWrite: false,
      incrementalChanges: true,
      rollback: false,
      assetDiscovery: false,
      liveStateRead: true,
      playheadWrite: false,
      frameCapture: false,
      projectCatalogRead: false,
      projectSelection: false,
      compositeTransactions: false,
    },
    analyzers: {
      speechTranscribe: false,
      speechVad: false,
      audioLoudness: false,
      visualTrack: false,
    },
  }, { backend: "workflow-extension-ipc" });
  const live = {
    getIdentity: async () => ({ name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" }),
    getCapabilities: async () => metadataCapabilities,
    readLiveState: async () => {
      throw new Error("metadata-only fixture has no live state payload");
    },
    liveChangesSince: async () => [],
  };
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({ live }));
  const inspected = await runtime.inspectEditor();
  const preflight = createCapabilityPreflight(inspected.identity, inspected.capabilities, { processMode: "headless" });
  const unavailableReason = preflight.capabilities.canonicalDocument.write.unavailableReason
    ?? "canonical timeline writes are unavailable";
  return {
    preflight: {
      mode: "headless",
      backend: preflight.backend,
      guarantee: "observed",
      capabilities: preflight.capabilities,
      unavailableReason,
    },
    workflows: loadNativeEditingManifest().workflows.map((workflow) => ({
      workflowId: workflow.id,
      status: "unsupported",
      passed: true,
      reason: unavailableReason,
    })),
  };
}

async function collectEvidenceTiers(input: {
  manifest: NativeEditingManifest;
  deterministicPassed: boolean;
  deterministicWorkflows: TierWorkflowResult[];
  fcpxmlWorkflows: TierWorkflowResult[];
  metadataOnly: MetadataOnlyResult;
  headedEvidenceDirectory?: string;
}): Promise<ReleaseGateEvidenceTiers> {
  const deterministic = createTierEvidence(
    "deterministic",
    input.deterministicPassed && input.deterministicWorkflows.every((workflow) => workflow.passed),
    "headless",
    "fixture",
    "verified",
    input.deterministicWorkflows,
    { mode: "headless", backend: "fixture", guarantee: "verified" },
  );
  const fcpxmlArtifact = createTierEvidence(
    "fcpxml-artifact",
    input.fcpxmlWorkflows.every((workflow) => workflow.passed),
    "headless",
    "fcpxml-document",
    "artifact-write",
    input.fcpxmlWorkflows,
    { mode: "headless", backend: "fcpxml-document", guarantee: "artifact-write" },
  );
  const metadataOnly = createTierEvidence(
    "metadata-only",
    true,
    "headless",
    input.metadataOnly.preflight.backend,
    "observed",
    input.metadataOnly.workflows,
    input.metadataOnly.preflight,
  );
  const canonicalWorkflows = input.manifest.workflows
    .filter((workflow) => workflow.evidenceTiers.includes("canonical-live"))
    .map((workflow) => ({
      workflowId: workflow.id,
      status: "unsupported" as const,
      passed: true,
      reason: input.metadataOnly.preflight.unavailableReason,
    }));
  const canonicalLive = createTierEvidence(
    "canonical-live",
    true,
    "headless",
    input.metadataOnly.preflight.backend,
    "canonical-write",
    canonicalWorkflows,
    {
      ...input.metadataOnly.preflight,
      guarantee: "canonical-write",
      unavailableReason: input.metadataOnly.preflight.unavailableReason,
    },
    "unsupported",
  );
  const headed = await collectHeadedNativeEvidence(input.manifest, input.headedEvidenceDirectory);
  return { deterministic, "fcpxml-artifact": fcpxmlArtifact, "metadata-only": metadataOnly, "canonical-live": canonicalLive, "headed-native": headed };
}

function createTierEvidence(
  tier: string,
  passed: boolean,
  mode: EvidenceMode,
  backend: string,
  guarantee: string,
  workflows: TierWorkflowResult[],
  preflight: ReleaseGateEvidence["preflight"],
  explicitStatus?: EvidenceStatus,
): ReleaseGateEvidence {
  const status = explicitStatus ?? (passed ? "verified" : "failed");
  return {
    tier,
    status,
    attempted: true,
    passed,
    mode,
    backend,
    guarantee,
    preflight,
    workflows,
  };
}

async function collectHeadedNativeEvidence(
  manifest: NativeEditingManifest,
  evidenceDirectory?: string,
): Promise<ReleaseGateEvidence> {
  const preflight: ReleaseGateEvidence["preflight"] = {
    mode: "headed",
    backend: "final-cut-accessibility",
    guarantee: "native-verified",
    unavailableReason: evidenceDirectory
      ? "no matching headed evidence was supplied for this workflow"
      : "opt-in headed evidence directory was not supplied",
  };
  const workflows = await readHeadedEvidence(manifest, evidenceDirectory);
  const attempted = workflows.some((workflow) => workflow.status !== "unrun");
  const failed = workflows.some((workflow) => workflow.status === "failed");
  const expectedWorkflows = workflows.filter((workflow) => {
    const manifestWorkflow = manifest.workflows.find((candidate) => candidate.id === workflow.workflowId);
    return (manifestWorkflow?.evidenceTypes.length ?? 0) > 0;
  });
  const complete = expectedWorkflows.length > 0 && expectedWorkflows.every((workflow) => workflow.status === "verified");
  const status: EvidenceStatus = failed || attempted && !complete
    ? "failed"
    : complete
      ? "verified"
      : "unrun";
  return {
    tier: "headed-native",
    status,
    attempted,
    passed: status === "verified",
    mode: "headed",
    backend: "final-cut-accessibility",
    guarantee: "native-verified",
    preflight,
    workflows,
  };
}

async function readHeadedEvidence(
  manifest: NativeEditingManifest,
  evidenceDirectory?: string,
): Promise<TierWorkflowResult[]> {
  if (!evidenceDirectory) {
    return manifest.workflows
      .filter((workflow) => workflow.evidenceTiers.includes("headed-native"))
      .map((workflow) => ({ workflowId: workflow.id, status: "unrun", passed: false, reason: "opt-in headed evidence was not requested" }));
  }
  let files: string[];
  try {
    files = (await readdir(evidenceDirectory)).filter((file) => file.endsWith(".json"));
  } catch {
    return manifest.workflows
      .filter((workflow) => workflow.evidenceTiers.includes("headed-native"))
      .map((workflow) => ({ workflowId: workflow.id, status: "failed", passed: false, reason: "headed evidence directory could not be read" }));
  }
  const values: unknown[] = [];
  for (const file of files) {
    try {
      values.push(JSON.parse(await readFile(join(evidenceDirectory, file), "utf8")));
    } catch {
      values.push({ evidenceType: `invalid:${file}`, passed: false });
    }
  }
  const results: TierWorkflowResult[] = [];
  for (const workflow of manifest.workflows.filter((candidate) => candidate.evidenceTiers.includes("headed-native"))) {
    if (workflow.evidenceTypes.length === 0) {
      results.push({ workflowId: workflow.id, status: "unrun", passed: false, reason: "no headed runner is registered" });
      continue;
    }
    const matches = values.filter((value) => {
      const evidenceType = value && typeof value === "object" ? (value as Record<string, unknown>).evidenceType : undefined;
      return typeof evidenceType === "string" && workflow.evidenceTypes.includes(evidenceType);
    });
    if (matches.length === 0) {
      results.push({ workflowId: workflow.id, status: "unrun", passed: false, reason: "matching headed evidence was not supplied" });
      continue;
    }
    if (matches.length > 1) {
      results.push({ workflowId: workflow.id, status: "failed", passed: false, reason: "multiple headed evidence records matched one workflow" });
      continue;
    }
    try {
      const summary = summarizeHeadedEvidence(matches[0], workflow);
      results.push({
        workflowId: workflow.id,
        status: "verified",
        passed: true,
        evidenceType: summary.evidenceType,
        target: summary.target,
        revision: summary.revision,
        verification: summary.verification,
      });
    } catch (error) {
      results.push({ workflowId: workflow.id, status: "failed", passed: false, reason: safeFailure(error) });
    }
  }
  return results;
}

function buildWorkflowMatrix(
  manifest: NativeEditingManifest,
  evidenceTiers: ReleaseGateEvidenceTiers,
): ReleaseGateWorkflowMatrixEntry[] {
  return manifest.workflows.map((workflow) => ({
    workflowId: workflow.id,
    operation: workflow.operation,
    capability: workflow.capability,
    evidence: workflow.evidenceTiers.map((tier) => {
      const result = evidenceTiers[tier].workflows.find((candidate) => candidate.workflowId === workflow.id);
      return {
        tier,
        status: result?.status ?? "unrun",
        passed: result?.passed ?? false,
        ...(result?.reason ? { reason: result.reason } : {}),
      };
    }),
  }));
}

function aggregateWorkflow(
  workflowId: "filler-removal" | "dialogue-normalization",
  workflows: ReleaseGateWorkflowEvidence[],
): TierWorkflowResult {
  const familyWorkflows = workflows.filter((workflow) => workflow.family === workflowId);
  const passed = familyWorkflows.length > 0 && familyWorkflows.every((workflow) => workflow.passed);
  return {
    workflowId,
    status: passed ? "verified" : "failed",
    passed,
    ...(passed ? {} : { reason: `deterministic ${workflowId} corpus did not pass` }),
  };
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":", 1)[0] || "release gate workflow failed";
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
  let plannedMutation = false;

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const skills = parseJson(await client.callTool({ name: "skill.list", arguments: {} })) as Array<{ id: string }>;
    assert.deepEqual(skills.map((skill) => skill.id), ["audio-noise-reduction", "color-correction", "dialogue-normalization", "filler-removal"]);
    before = parseJson(await client.callTool({ name: "project.inspect", arguments: {} })) as ProjectSnapshot;
    previewed = true;
    const previewResult = await client.callTool({
      name: "skill.preview",
      arguments: { skill: workflow.family, arguments: { ...skillArguments, baseRevision: before.revision } },
    });
    if (previewResult.isError) throw new Error(parseToolError(previewResult));
    const preview = parseJson(previewResult) as Record<string, any>;
    previewEvidence = sanitizePreview(preview);
    plannedMutation = Array.isArray(preview.plan?.operations) && preview.plan.operations.length > 0;

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
    && (workflow.expectedOutcome === "verified"
      ? plannedMutation ? beforeDigest !== afterDigest : unchanged
      : unchanged);
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
    frameDuration: { value: "1", timescale: "30" },
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
    capabilities: { transcription: true, vad: true },
    analyze: async ({ project }) => {
      const clip = project.timeline.clips.find((candidate) => candidate.id === "filler-clip");
      if ((clip?.duration ?? 6) >= 6 || !["obvious", "multi-filler", "verification-rollback"].includes(scenario)) {
        return {
          words: structuredClone(originalWords),
          vadSegments: originalWords.map((word) => ({ start: word.start, end: word.end, kind: "speech" as const })),
        };
      }
      return {
        words: originalWords.flatMap((word) => {
          if (word.filler) return [];
          return [{ ...word }];
        }),
        vadSegments: originalWords
          .filter((word) => word.filler !== true)
          .map((word) => ({ start: word.start, end: word.end, kind: "speech" as const })),
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
    ...(transaction.verification?.passed !== undefined ? { verificationPassed: transaction.verification.passed } : {}),
    ...(transaction.diff !== undefined ? { diff: transaction.diff } : {}),
  };
}

function isExpectedSkipFailure(message: string): boolean {
  return /NO_FILLERS_FOUND|ANALYSIS_INVALID|CAPABILITY_UNAVAILABLE/.test(message);
}
