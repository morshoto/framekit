import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("./manifest.json", import.meta.url));
const expectedTierIds = ["deterministic", "fcpxml-artifact", "metadata-only", "canonical-live", "headed-native"] as const;
const expectedWorkflowIds = [
  "canonical-live",
  "picture-in-picture",
  "built-in-title-discovery",
  "masking",
  "filler-removal",
  "dialogue-normalization",
] as const;

export type NativeEditingEvidenceTier = (typeof expectedTierIds)[number];
export type EvidenceStatus = "verified" | "failed" | "unsupported" | "unrun";
export type EvidenceMode = "headless" | "headed";

export interface NativeEditingManifest {
  schemaVersion: 1;
  manifestVersion: string;
  gate: "v0.1.6-native-editing";
  releaseVersion: "0.1.6";
  runtimeContract: "v0.1.6";
  evidenceTiers: Array<{
    id: NativeEditingEvidenceTier;
    mode: EvidenceMode;
    guarantee: string;
    required: boolean;
  }>;
  workflows: Array<{
    id: (typeof expectedWorkflowIds)[number];
    operation: string;
    capability: string;
    evidenceTiers: NativeEditingEvidenceTier[];
    headedRunner?: string;
    evidenceTypes: string[];
  }>;
}

export interface HeadedEvidenceSummary {
  schemaVersion: 1;
  workflowId: string;
  evidenceType: string;
  status: "verified";
  recordedAt?: string;
  environment: {
    framekitVersion: string;
    finalCutVersion: string;
    gitCommit: string;
  };
  editor?: { name: string; version: string; backend: string };
  target: {
    project?: string;
    projectId?: string;
    sequenceId?: string;
    occurrenceId?: string;
    occurrenceName?: string;
  };
  revision: { before: string; after: string; restored: string };
  verification: { execute: true; undo: true };
}

export interface ReleaseProvenanceInput {
  packageManifest: { name?: string; version?: string; private?: boolean };
  pluginManifest: { name?: string; version?: string };
  serverVersion?: string;
  releaseTag?: string;
  githubRelease?: { tagName?: string; draft?: boolean };
  workflow?: { status?: string; conclusion?: string; headSha?: string; tagSha?: string };
  npmVersion?: string;
  nativeAssets?: Array<{ name: string; sha256?: string; content?: string }>;
}

export interface ReleaseProvenanceReport {
  releaseReady: boolean;
  checks: Array<{
    name: string;
    status: EvidenceStatus;
    detail: string;
  }>;
  summary: string;
}

export function loadNativeEditingManifest(): NativeEditingManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NativeEditingManifest;
  assert.equal(manifest.schemaVersion, 1, "unsupported native editing manifest schema");
  assert.equal(manifest.gate, "v0.1.6-native-editing");
  assert.equal(manifest.releaseVersion, "0.1.6");
  assert.equal(manifest.runtimeContract, "v0.1.6");
  assert.deepEqual(manifest.evidenceTiers.map((tier) => tier.id), expectedTierIds);
  const tierIds = new Set(manifest.evidenceTiers.map((tier) => tier.id));
  assert.equal(manifest.evidenceTiers.filter((tier) => tier.required).length, 1);
  for (const tier of manifest.evidenceTiers) {
    assert.equal(tier.mode === "headless" || tier.mode === "headed", true);
    assert.equal(typeof tier.guarantee, "string");
  }
  assert.deepEqual(manifest.workflows.map((workflow) => workflow.id), expectedWorkflowIds);
  const workflowIds = new Set<string>();
  for (const workflow of manifest.workflows) {
    assert.equal(workflowIds.has(workflow.id), false, `duplicate native workflow ${workflow.id}`);
    workflowIds.add(workflow.id);
    assert.ok(workflow.operation);
    assert.ok(workflow.capability);
    assert.ok(workflow.evidenceTiers.length > 0);
    for (const tier of workflow.evidenceTiers) assert.equal(tierIds.has(tier), true);
    if (workflow.evidenceTypes.length > 0) assert.match(workflow.headedRunner ?? "", /^scripts\/final-cut-.*-e2e\.mjs$/);
  }
  return manifest;
}

export function summarizeHeadedEvidence(
  value: unknown,
  workflow: NativeEditingManifest["workflows"][number],
): HeadedEvidenceSummary {
  assert(value && typeof value === "object" && !Array.isArray(value), "headed evidence must be an object");
  const raw = value as Record<string, any>;
  assert.equal(raw.passed, true, `${workflow.id}: headed evidence did not pass`);
  const evidenceType = requireString(raw.evidenceType, "headed evidence type");
  assert.equal(workflow.evidenceTypes.includes(evidenceType), true, `${workflow.id}: unexpected headed evidence type`);

  const environment = raw.environment as Record<string, unknown> | undefined;
  const sanitizedEnvironment = {
    framekitVersion: requireString(environment?.framekitVersion, "headed framekit version"),
    finalCutVersion: requireString(environment?.finalCutVersion, "headed Final Cut version"),
    gitCommit: requireSha(environment?.gitCommit, "headed git commit"),
  };
  const editor = raw.editor && typeof raw.editor === "object"
    ? {
        name: requireString(raw.editor.name, "headed editor name"),
        version: requireString(raw.editor.version, "headed editor version"),
        backend: requireString(raw.editor.backend, "headed editor backend"),
      }
    : undefined;
  const target = extractTarget(raw);
  const revision = extractRevisions(raw);
  const verification = extractVerification(raw);

  return {
    schemaVersion: 1,
    workflowId: workflow.id,
    evidenceType,
    status: "verified",
    ...(typeof raw.recordedAt === "string" ? { recordedAt: raw.recordedAt } : {}),
    environment: sanitizedEnvironment,
    ...(editor ? { editor } : {}),
    target,
    revision,
    verification,
  };
}

export function assessReleaseProvenance(input: ReleaseProvenanceInput): ReleaseProvenanceReport {
  const checks: ReleaseProvenanceReport["checks"] = [];
  const packageVersion = input.packageManifest.version;
  const pluginVersion = input.pluginManifest.version;

  if (packageVersion && pluginVersion && packageVersion === pluginVersion) {
    checks.push(verified("package-plugin-versions", `package and plugin are ${packageVersion}`));
  } else {
    checks.push(failed("package-plugin-versions", "package and plugin versions do not align"));
  }

  if (input.serverVersion && packageVersion && input.serverVersion === packageVersion) {
    checks.push(verified("mcp-server-version", `MCP server reports ${input.serverVersion}`));
  } else if (input.serverVersion) {
    checks.push(failed("mcp-server-version", "MCP server version does not match package version"));
  } else {
    checks.push(unrun("mcp-server-version", "runtime MCP server version was not probed"));
  }

  if (input.releaseTag) {
    if (packageVersion && input.releaseTag === `v${packageVersion}`) {
      checks.push(verified("release-tag", `${input.releaseTag} matches package version`));
    } else {
      checks.push(failed("release-tag", "release tag does not match package version"));
    }
  } else {
    checks.push(unrun("release-tag", "no release tag was supplied"));
  }

  if (input.githubRelease) {
    const matches = input.githubRelease.tagName === input.releaseTag
      && input.githubRelease.draft === false;
    checks.push(matches
      ? verified("github-release", "published GitHub release matches the release tag")
      : failed("github-release", "GitHub release is missing, draft, or tagged differently"));
  } else {
    checks.push(unrun("github-release", "GitHub release state was not supplied"));
  }

  if (input.workflow) {
    const successful = input.workflow.status === "completed" && input.workflow.conclusion === "success";
    const tagMatches = Boolean(
      input.workflow.headSha
      && input.workflow.tagSha
      && input.workflow.tagSha === input.workflow.headSha,
    );
    checks.push(successful && tagMatches
      ? verified("release-workflow", "release workflow completed successfully")
      : failed("release-workflow", "release workflow is incomplete, failed, or points at a different commit"));
  } else {
    checks.push(unrun("release-workflow", "release workflow state was not supplied"));
  }

  if (input.npmVersion) {
    checks.push(input.npmVersion === packageVersion
      ? verified("npm-publication", `npm publishes ${input.npmVersion}`)
      : failed("npm-publication", "npm publication does not match package version"));
  } else {
    checks.push(unrun("npm-publication", "npm registry publication was not probed"));
  }

  checks.push(assessNativeAssets(input.nativeAssets, packageVersion));
  const releaseReady = checks.every((check) => check.status === "verified");
  const blockers = checks.filter((check) => check.status !== "verified").map((check) => check.name);
  return {
    releaseReady,
    checks,
    summary: releaseReady
      ? "release provenance is complete"
      : `release completion is blocked by ${blockers.join(", ")}`,
  };
}

function assessNativeAssets(
  assets: ReleaseProvenanceInput["nativeAssets"],
  packageVersion: string | undefined,
): ReleaseProvenanceReport["checks"][number] {
  if (!assets) return unrun("native-assets", "native release assets were not supplied");
  const archiveName = `FramekitFinalCutWorkflow-${packageVersion}.zip`;
  const checksumName = `${archiveName}.sha256`;
  const archive = assets.find((asset) => asset.name === archiveName);
  const checksum = assets.find((asset) => asset.name === checksumName);
  const valid = Boolean(archive && checksum)
    && Boolean(archive?.sha256 && /^[a-f0-9]{64}$/i.test(archive.sha256))
    && Boolean(checksum?.sha256 && /^[a-f0-9]{64}$/i.test(checksum.sha256))
    && Boolean(archive?.sha256 && checksum?.content && checksumLineMatches(checksum.content, archiveName, archive.sha256));
  return valid
    ? verified("native-assets", `native archive and checksum exist for ${packageVersion}`)
    : failed("native-assets", "native archive or checksum is missing, malformed, or mismatched");
}

function checksumLineMatches(content: string, archiveName: string, archiveSha256: string): boolean {
  const escapedName = archiveName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${archiveSha256}\\s+\\*?${escapedName}$`, "i").test(content.trim());
}

function extractTarget(raw: Record<string, any>): HeadedEvidenceSummary["target"] {
  const project = raw.project;
  const target = raw.target ?? raw.placement?.target;
  const projectValue = typeof project === "string" ? project : project?.name ?? raw.placement?.project;
  const projectId = typeof project === "object" ? project?.id : undefined;
  const sequenceId = typeof project === "object" ? project?.sequenceId : target?.sequenceId;
  const occurrenceId = target?.occurrenceId;
  const occurrenceName = target?.occurrenceName ?? target?.name;
  return {
    ...(typeof projectValue === "string" ? { project: projectValue } : {}),
    ...(typeof projectId === "string" ? { projectId } : {}),
    ...(typeof sequenceId === "string" ? { sequenceId } : {}),
    ...(typeof occurrenceId === "string" ? { occurrenceId } : {}),
    ...(typeof occurrenceName === "string" ? { occurrenceName } : {}),
  };
}

function extractRevisions(raw: Record<string, any>): HeadedEvidenceSummary["revision"] {
  const source = raw.revisions ?? raw.placement ?? raw.removal ?? raw.mutation;
  const before = revisionId(source?.before ?? source?.beforeRevision);
  const after = revisionId(source?.after ?? source?.afterRevision);
  const restored = revisionId(source?.restored ?? raw.restoration?.restoredRevision ?? raw.placement?.undoRevision);
  return {
    before: requireString(before, "headed before revision"),
    after: requireString(after, "headed after revision"),
    restored: requireString(restored, "headed restored revision"),
  };
}

function extractVerification(raw: Record<string, any>): HeadedEvidenceSummary["verification"] {
  const execute = raw.placement?.observed !== undefined
    || raw.mask?.observed !== undefined
    || raw.placement?.verified === true
    || raw.removal?.continuityVerified === true
    || raw.mutation?.status === "VERIFIED"
    || raw.verification?.execute?.verified === true;
  const undo = raw.placement?.undoVerified?.verified === true
    || raw.mask?.undo?.verified === true
    || raw.placement?.undo?.verified === true
    || raw.undo?.verified === true
    || raw.restoration?.restored === true;
  assert.equal(execute, true, "headed execute verification is missing");
  assert.equal(undo, true, "headed Undo or rollback verification is missing");
  return { execute: true, undo: true };
}

function revisionId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string") {
    return (value as Record<string, string>).id;
  }
  return undefined;
}

function verified(name: string, detail: string) {
  return { name, status: "verified" as const, detail };
}

function failed(name: string, detail: string) {
  return { name, status: "failed" as const, detail };
}

function unrun(name: string, detail: string) {
  return { name, status: "unrun" as const, detail };
}

function requireString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} is missing`);
  const result = value as string;
  assert.ok(result.length > 0, `${label} is empty`);
  return result;
}

function requireSha(value: unknown, label: string): string {
  const result = requireString(value, label);
  assert.match(result, /^[a-f0-9]{40}$/i, `${label} must be a full commit SHA`);
  return result;
}
