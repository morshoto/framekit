import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  FramekitProjectStore,
  LocalMediaRegistrar,
  ProjectTransactionService,
  createFramekitRenderRequest,
  renderAndVerifyFramekitProject,
  type ContextRevision,
  type FramekitProjectDocument,
  type FramekitRenderArtifactVerifier,
  type FramekitRenderProvider,
  type FramekitRenderParameters,
  type LocalMediaMetadataProbe,
  type ProjectEditCommand,
  type ProjectEditPreview,
  type ProjectEditResult,
  type RoughCutPlan,
  type TimelineIrEditOperation,
  type TimelineIr,
  timelineIrDigest,
} from "@framekit/runtime";
import {
  FcpxmlDocumentAdapter,
  compileTimelineIrToFcpxml,
  resolveMediaSource,
  type TimelineIrToFcpxmlResult,
  type TimelineIrToFcpxmlTarget,
} from "@framekit/final-cut";

export interface HeadlessProjectServiceOptions {
  directory: string;
  mediaProbe?: LocalMediaMetadataProbe;
  renderer?: FramekitRenderProvider;
  verifier?: FramekitRenderArtifactVerifier;
  clock?: () => string;
}

export interface HeadlessProjectSummary {
  projectId: string;
  projectName: string;
  sequenceId: string;
  sequenceName: string;
  revision: ContextRevision;
  path: string;
}

export interface HeadlessRenderRecord {
  renderId: string;
  projectId: string;
  sequenceId: string;
  requestedRevision: ContextRevision;
  createdAt: string;
  status: "passed" | "failed" | "unavailable";
  outcome: unknown;
}

export interface HeadlessRoughCutRequest {
  projectId: string;
  sequenceId: string;
  plan: RoughCutPlan;
  operations?: TimelineIrEditOperation[];
  sourceAudioPolicy?: "preserve-and-mix";
  render: FramekitRenderParameters;
  fcpxml: {
    path: string;
    target: TimelineIrToFcpxmlTarget;
    overwrite?: boolean;
  };
}

export interface HeadlessRoughCutExecutionRequest extends HeadlessRoughCutRequest {
  approved: boolean;
  planDigest: string;
}

export interface HeadlessRoughCutShotProvenance {
  order: number;
  occurrenceId: string;
  mediaId: string;
  sourceIdentity: RoughCutPlan["shots"][number]["sourceIdentity"];
  sourceRange: RoughCutPlan["shots"][number]["range"];
  confidence: number;
  matchedProperties: string[];
  rationale: string;
  evidence?: HeadlessRoughCutSpeechEvidence;
}

interface HeadlessRoughCutSpeechEvidence {
  kind: "speech";
  transcript: string;
  wordCount: number;
  averageWordConfidence: number;
  vad?: {
    kind: "speech" | "silence" | "breath" | "laughter" | "noise";
    confidence?: number;
  };
  audio?: {
    integratedLufs?: number;
    truePeakDb?: number;
    silenceMs?: number;
  };
}

type RoughCutShotWithEvidence = RoughCutPlan["shots"][number] & {
  evidence?: HeadlessRoughCutSpeechEvidence;
};

export interface HeadlessRoughCutPreview extends ProjectEditPreview {
  plan: RoughCutPlan;
  planDigest: string;
  provenance: HeadlessRoughCutShotProvenance[];
  outputIntent: {
    sourceAudioPolicy: "preserve-and-mix";
    render: FramekitRenderParameters;
    fcpxml: { path: string; target: TimelineIrToFcpxmlTarget; overwrite: boolean };
  };
  fcpxml: Pick<TimelineIrToFcpxmlResult, "digest" | "target" | "destination" | "coverage" | "provenance">;
}

export interface HeadlessRoughCutExecution extends HeadlessRoughCutPreview {
  executionId: string;
  committed: true;
  render: {
    renderId: string;
    status: "passed";
    outcome: unknown;
  };
  fcpxmlArtifact: {
    path: string;
    digest: string;
    bytes: number;
    verified: true;
  };
  transaction: ProjectEditResult;
}

export interface HeadlessRoughCutPublishProof {
  executionId: string;
  sourceTransactionId: string;
  projectId: string;
  sequenceId: string;
  sourceRevision: ContextRevision;
  canonicalRevision: ContextRevision;
  planDigest: string;
  renderId: string;
  artifactPath: string;
  artifactDigest: string;
  sourceAudioPolicy: "preserve-and-mix";
  target: TimelineIrToFcpxmlTarget;
  destination: TimelineIrToFcpxmlResult["destination"];
  coverage: TimelineIrToFcpxmlResult["coverage"];
  provenance: HeadlessRoughCutShotProvenance[];
  targetLibraryUid: string;
  sourceMediaDigests: Array<{ source: string; sha256: string }>;
}

interface HeadlessRoughCutExecutionRecord {
  schemaVersion: 1;
  executionId: string;
  approved: true;
  projectId: string;
  sequenceId: string;
  sourceRevision: ContextRevision;
  canonicalRevision: ContextRevision;
  plan: RoughCutPlan;
  operations: TimelineIrEditOperation[];
  outputIntent: HeadlessRoughCutPreview["outputIntent"];
  planDigest: string;
  inputDigest: string;
  renderId: string;
  artifactPath: string;
  artifactDigest: string;
  artifactBytes: number;
  fcpxml: HeadlessRoughCutPreview["fcpxml"];
  provenance: HeadlessRoughCutShotProvenance[];
  evidenceDigest: string;
}

interface HeadlessRoughCutApprovalRecord {
  schemaVersion: 1;
  planDigest: string;
  inputDigest: string;
  projectId: string;
  sequenceId: string;
  sourceRevision: ContextRevision;
  canonicalRevision: ContextRevision;
  artifactPath: string;
  artifactDigest: string;
  outputIntent: HeadlessRoughCutPreview["outputIntent"];
  evidenceDigest: string;
}

export class HeadlessProjectService {
  private readonly directory: string;
  private readonly mediaProbe?: LocalMediaMetadataProbe;
  private readonly renderer?: FramekitRenderProvider;
  private readonly verifier?: FramekitRenderArtifactVerifier;
  private readonly clock: () => string;

  public constructor(options: HeadlessProjectServiceOptions) {
    this.directory = options.directory;
    this.mediaProbe = options.mediaProbe;
    this.renderer = options.renderer;
    this.verifier = options.verifier;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public async create(timeline: TimelineIr): Promise<FramekitProjectDocument> {
    const store = this.store(timeline.project.id);
    const timestamp = this.clock();
    return store.create({
      schemaVersion: 1,
      metadata: { createdAt: timestamp, updatedAt: timestamp },
      timeline,
    });
  }

  public async list(): Promise<HeadlessProjectSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const summaries: HeadlessProjectSummary[] = [];
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json") && !candidate.name.startsWith("render-"))) {
      const projectId = entry.name.slice(0, -".json".length);
      const project = await this.store(projectId).load();
      summaries.push(toSummary(project, this.projectPath(projectId)));
    }
    return summaries.sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  public async open(projectId: string): Promise<FramekitProjectDocument> {
    const project = await this.store(projectId).load();
    const hasLocalMedia = project.timeline.resources.some((resource) => resource.sourceKind === "local-file");
    if (hasLocalMedia && !this.mediaProbe) {
      throw new Error("HEADLESS_MEDIA_PROBE_UNAVAILABLE: local-file resources require a configured media probe");
    }
    if (this.mediaProbe) await new LocalMediaRegistrar(this.store(projectId), this.mediaProbe).reopen();
    return project;
  }

  public async inspect(projectId: string): Promise<FramekitProjectDocument> {
    return this.open(projectId);
  }

  public async registerMedia(projectId: string, sourcePath: string, expectedRevision?: ContextRevision) {
    if (!this.mediaProbe) throw new Error("HEADLESS_MEDIA_PROBE_UNAVAILABLE: no local media metadata probe is configured");
    return new LocalMediaRegistrar(this.store(projectId), this.mediaProbe, { clock: this.clock }).register(sourcePath, expectedRevision);
  }

  public async previewEdit(projectId: string, command: Omit<ProjectEditCommand, "target"> & { target?: ProjectEditCommand["target"] }, sequenceId: string) {
    await this.open(projectId);
    const transaction = new ProjectTransactionService(this.store(projectId), { clock: this.clock });
    return transaction.preview({
      ...command,
      target: command.target ?? { projectId, sequenceId },
    });
  }

  public async executeEdit(projectId: string, command: Omit<ProjectEditCommand, "target"> & { target?: ProjectEditCommand["target"] }, sequenceId: string) {
    await this.open(projectId);
    const transaction = new ProjectTransactionService(this.store(projectId), { clock: this.clock });
    return transaction.execute({
      ...command,
      target: command.target ?? { projectId, sequenceId },
    });
  }

  public async previewRoughCut(request: HeadlessRoughCutRequest): Promise<HeadlessRoughCutPreview> {
    const prepared = await this.prepareRoughCut(request);
    const timestamp = this.clock();
    const { preview, fcpxml } = await this.previewPreparedRoughCut(request, prepared, timestamp);
    const approval = createRoughCutApproval({
      inputDigest: prepared.inputDigest,
      projectId: request.projectId,
      sequenceId: request.sequenceId,
      sourceRevision: request.plan.revision,
      canonicalRevision: preview.after.timeline.revision,
      artifactPath: resolve(request.fcpxml.path),
      artifactDigest: fcpxml.digest,
      outputIntent: prepared.outputIntent,
    });
    await this.saveRoughCutApproval(approval);
    return {
      ...preview,
      plan: structuredClone(request.plan),
      planDigest: approval.planDigest,
      provenance: prepared.provenance,
      outputIntent: prepared.outputIntent,
      fcpxml: selectFcpxmlMetadata(fcpxml),
    };
  }

  public async executeRoughCut(request: HeadlessRoughCutExecutionRequest): Promise<HeadlessRoughCutExecution> {
    if (request.approved !== true) {
      throw new Error("HEADLESS_ROUGH_CUT_APPROVAL_REQUIRED: set approved=true after reviewing the preview");
    }
    const prepared = await this.prepareRoughCut(request);
    if (!/^[a-f0-9]{64}$/.test(request.planDigest)) {
      throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: planDigest does not match the submitted rough-cut plan");
    }
    let approval: HeadlessRoughCutApprovalRecord;
    try {
      approval = await this.readRoughCutApproval(request.planDigest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: planDigest has no persisted preview approval");
      }
      throw error;
    }
    if (approval.inputDigest !== prepared.inputDigest
      || approval.projectId !== request.projectId
      || approval.sequenceId !== request.sequenceId
      || !sameRevision(approval.sourceRevision, request.plan.revision)
      || approval.artifactPath !== resolve(request.fcpxml.path)
      || stableJson(approval.outputIntent) !== stableJson(prepared.outputIntent)) {
      throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: planDigest does not match the submitted rough-cut plan");
    }

    const transaction = new ProjectTransactionService(this.store(request.projectId), {
      clock: () => approval.canonicalRevision.timestamp,
    });
    const { preview, fcpxml } = await this.previewPreparedRoughCut(
      request,
      prepared,
      approval.canonicalRevision.timestamp,
      transaction,
    );
    if (!sameRevision(preview.after.timeline.revision, approval.canonicalRevision)
      || fcpxml.digest !== approval.artifactDigest) {
      throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: replayed preview differs from the approved revision or FCPXML digest");
    }
    const renderRequest = createFramekitRenderRequest({
      timeline: preview.after.timeline,
      target: { projectId: request.projectId, sequenceId: request.sequenceId },
      revision: preview.after.timeline.revision,
      parameters: request.render,
    });
    if (!this.renderer || !this.verifier) {
      throw new Error("HEADLESS_ROUGH_CUT_RENDER_UNAVAILABLE: renderer and verifier are not configured");
    }
    const outcome = await renderAndVerifyFramekitProject(renderRequest, this.renderer, this.verifier);
    const renderId = `render-${randomUUID()}`;
    const renderRecord: HeadlessRenderRecord = {
      renderId,
      projectId: request.projectId,
      sequenceId: request.sequenceId,
      requestedRevision: renderRequest.projectRevision,
      createdAt: this.clock(),
      status: outcome.status,
      outcome,
    };
    await this.saveRender(renderRecord);
    if (outcome.status !== "passed") {
      throw new Error(`HEADLESS_ROUGH_CUT_RENDER_FAILED: render verification status was ${outcome.status}; inspect ${renderId}`);
    }
    const fcpxmlArtifact = await writeVerifiedFcpxml(
      request.fcpxml.path,
      fcpxml.xml,
      fcpxml.digest,
      request.fcpxml.overwrite === true,
    );
    const committed = await transaction.execute(prepared.command);
    const executionId = `rough-cut-${randomUUID()}`;
    await this.saveRoughCutExecution({
      schemaVersion: 1,
      executionId,
      approved: true,
      projectId: request.projectId,
      sequenceId: request.sequenceId,
      sourceRevision: structuredClone(request.plan.revision),
      canonicalRevision: structuredClone(committed.after.timeline.revision),
      plan: structuredClone(request.plan),
      operations: structuredClone(request.operations ?? []),
      outputIntent: structuredClone(prepared.outputIntent),
      planDigest: approval.planDigest,
      inputDigest: prepared.inputDigest,
      renderId,
      artifactPath: resolve(fcpxmlArtifact.path),
      artifactDigest: fcpxmlArtifact.digest,
      artifactBytes: fcpxmlArtifact.bytes,
      fcpxml: selectFcpxmlMetadata(fcpxml),
      provenance: structuredClone(prepared.provenance),
    });
    return {
      ...preview,
      after: committed.after,
      plan: structuredClone(request.plan),
      planDigest: approval.planDigest,
      provenance: prepared.provenance,
      outputIntent: prepared.outputIntent,
      fcpxml: selectFcpxmlMetadata(fcpxml),
      executionId,
      committed: true,
      render: { renderId, status: "passed", outcome },
      fcpxmlArtifact,
      transaction: committed,
    };
  }

  public async verifyPublishableRoughCut(
    executionId: string,
    artifactPath: string,
    artifactDigest?: string,
  ): Promise<HeadlessRoughCutPublishProof> {
    validateExecutionId(executionId);
    let record: HeadlessRoughCutExecutionRecord;
    try {
      record = JSON.parse(await readFile(this.executionPath(executionId), "utf8")) as HeadlessRoughCutExecutionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`HEADLESS_ROUGH_CUT_EXECUTION_NOT_FOUND: unknown approved rough-cut execution ${executionId}`);
      }
      throw error;
    }
    const { evidenceDigest, ...unsignedRecord } = record;
    if (record.schemaVersion !== 1 || record.executionId !== executionId || record.approved !== true
      || !evidenceDigest || hash(stableJson(unsignedRecord)) !== evidenceDigest) {
      throw new Error(`HEADLESS_ROUGH_CUT_EXECUTION_INVALID: approved rough-cut provenance is invalid for ${executionId}`);
    }
    const expectedInputDigest = digestRoughCutPlan(record.plan, record.operations, record.outputIntent);
    if (expectedInputDigest !== record.inputDigest) {
      throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: persisted rough-cut input digest does not match its plan and output intent");
    }
    const approval = await this.readRoughCutApproval(record.planDigest);
    if (approval.inputDigest !== record.inputDigest
      || approval.projectId !== record.projectId
      || approval.sequenceId !== record.sequenceId
      || !sameRevision(approval.sourceRevision, record.sourceRevision)
      || !sameRevision(approval.canonicalRevision, record.canonicalRevision)
      || approval.artifactPath !== record.artifactPath
      || approval.artifactDigest !== record.artifactDigest
      || stableJson(approval.outputIntent) !== stableJson(record.outputIntent)) {
      throw new Error("HEADLESS_ROUGH_CUT_EXECUTION_INVALID: persisted execution differs from its approved preview");
    }
    if (!sameRevision(record.sourceRevision, record.plan.revision)) {
      throw new Error("HEADLESS_ROUGH_CUT_EXECUTION_INVALID: source revision differs from the approved plan revision");
    }
    if (!sameRevision(record.canonicalRevision, record.fcpxml.provenance.revision)) {
      throw new Error("HEADLESS_ROUGH_CUT_REVISION_MISMATCH: FCPXML provenance differs from the committed canonical revision");
    }
    if (record.fcpxml.destination.mode !== "versioned") {
      throw new Error("HEADLESS_ROUGH_CUT_TARGET_NOT_CREATE_ONLY: native delivery requires a versioned create-only project target");
    }
    if (resolve(artifactPath) !== record.artifactPath) {
      throw new Error("HEADLESS_ROUGH_CUT_ARTIFACT_TARGET_MISMATCH: requested path differs from the approved artifact path");
    }
    if (artifactDigest !== undefined && artifactDigest !== record.artifactDigest) {
      throw new Error("HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED: requested digest differs from the approved artifact digest");
    }

    const project = await this.open(record.projectId);
    if (project.timeline.sequence.id !== record.sequenceId
      || !sameRevision(project.timeline.revision, record.canonicalRevision)) {
      throw new Error("HEADLESS_ROUGH_CUT_STALE_REVISION: canonical project changed after the approved rough cut");
    }
    const approvedSnapshot = await new FcpxmlDocumentAdapter(record.artifactPath, undefined, {
      allowMissingImmutableIdsForReadback: true,
    }).readProject();
    const referencedMediaIds = new Set([
      ...approvedSnapshot.timeline.clips.map(({ mediaId }) => mediaId),
      ...approvedSnapshot.timeline.storyElements.map(({ mediaId }) => mediaId),
    ].filter((mediaId): mediaId is string => mediaId !== undefined));
    const approvedSources = approvedSnapshot.media
      .filter(({ mediaId }) => referencedMediaIds.has(mediaId))
      .map(({ source }) => resolve(source));
    const digestBySource = new Map(project.timeline.resources
      .filter((resource) => resource.source && resource.sourceDigest)
      .map((resource) => [resolveMediaSource(resource.source!, record.artifactPath), resource.sourceDigest!]));
    const sourceMediaDigests = [...new Set(approvedSources)].sort().map((source) => {
      const sha256 = digestBySource.get(source);
      if (!sha256) {
        throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MEDIA_DIGEST_UNAVAILABLE: no approved source digest is bound to ${source}`);
      }
      return { source, sha256 };
    });
    const render = await this.inspectRender(record.renderId);
    if (render.status !== "passed" || render.projectId !== record.projectId || render.sequenceId !== record.sequenceId
      || !sameRevision(render.requestedRevision, record.canonicalRevision)) {
      throw new Error("HEADLESS_ROUGH_CUT_RENDER_EVIDENCE_MISMATCH: render evidence does not match the approved revision");
    }
    const artifact = await readFile(record.artifactPath, "utf8");
    if (hash(artifact) !== record.artifactDigest || Buffer.byteLength(artifact) !== record.artifactBytes) {
      throw new Error("HEADLESS_ROUGH_CUT_ARTIFACT_CHANGED: approved FCPXML no longer matches its recorded digest");
    }
    if (!record.fcpxml.target.libraryUid?.trim()
      || !record.fcpxml.destination.projectUid?.trim()
      || !record.fcpxml.destination.sequenceUid?.trim()) {
      throw new Error("HEADLESS_ROUGH_CUT_TARGET_INVALID: approved FCPXML has no explicit library, project, and sequence target");
    }

    return {
      executionId,
      sourceTransactionId: `headless-rough-cut:${executionId}`,
      projectId: record.projectId,
      sequenceId: record.sequenceId,
      sourceRevision: structuredClone(record.sourceRevision),
      canonicalRevision: structuredClone(record.canonicalRevision),
      planDigest: record.planDigest,
      renderId: record.renderId,
      artifactPath: record.artifactPath,
      artifactDigest: record.artifactDigest,
      sourceAudioPolicy: record.outputIntent.sourceAudioPolicy,
      target: structuredClone(record.fcpxml.target),
      destination: structuredClone(record.fcpxml.destination),
      coverage: structuredClone(record.fcpxml.coverage),
      provenance: structuredClone(record.provenance),
      targetLibraryUid: record.fcpxml.target.libraryUid,
      sourceMediaDigests,
    };
  }

  public async verifyPublishableRoughCutTransaction(request: {
    sourceTransactionId: string;
    artifactPath: string;
    artifactDigest: string;
  }): Promise<HeadlessRoughCutPublishProof> {
    const prefix = "headless-rough-cut:";
    if (!request.sourceTransactionId.startsWith(prefix)) {
      throw new Error("HEADLESS_ROUGH_CUT_EXECUTION_INVALID: source transaction is not a rough-cut execution");
    }
    return this.verifyPublishableRoughCut(
      request.sourceTransactionId.slice(prefix.length),
      request.artifactPath,
      request.artifactDigest,
    );
  }

  public async render(
    projectId: string,
    sequenceId: string,
    parameters: FramekitRenderParameters,
    expectedRevision?: ContextRevision,
  ): Promise<HeadlessRenderRecord> {
    if (!this.renderer || !this.verifier) throw new Error("HEADLESS_RENDER_UNAVAILABLE: renderer and verifier are not configured");
    const project = await this.open(projectId);
    const request = createFramekitRenderRequest({
      timeline: project.timeline,
      target: { projectId, sequenceId },
      ...(expectedRevision ? { revision: expectedRevision } : {}),
      parameters,
    });
    const outcome = await renderAndVerifyFramekitProject(request, this.renderer, this.verifier);
    const renderId = `render-${randomUUID()}`;
    const record: HeadlessRenderRecord = {
      renderId,
      projectId,
      sequenceId,
      requestedRevision: request.projectRevision,
      createdAt: this.clock(),
      status: outcome.status,
      outcome,
    };
    await this.saveRender(record);
    return record;
  }

  public async inspectRender(renderId: string): Promise<HeadlessRenderRecord> {
    validateRenderId(renderId);
    try {
      return JSON.parse(await readFile(join(this.directory, `${renderId}.json`), "utf8")) as HeadlessRenderRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`HEADLESS_RENDER_NOT_FOUND: render record does not exist: ${renderId}`);
      throw error;
    }
  }

  private store(projectId: string): FramekitProjectStore {
    return new FramekitProjectStore(this.projectPath(projectId));
  }

  private projectPath(projectId: string): string {
    validateProjectId(projectId);
    return join(this.directory, `${projectId}.json`);
  }

  private executionPath(executionId: string): string {
    validateExecutionId(executionId);
    return join(this.directory, `${executionId}.json`);
  }

  private approvalPath(planDigest: string): string {
    validatePlanDigest(planDigest);
    return join(this.directory, `${planDigest}.approval.json`);
  }

  private async saveRender(record: HeadlessRenderRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${record.renderId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  }

  private async saveRoughCutExecution(record: Omit<HeadlessRoughCutExecutionRecord, "evidenceDigest">): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const execution = { ...record, evidenceDigest: hash(stableJson(record)) };
    const path = this.executionPath(record.executionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(execution)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  }

  private async saveRoughCutApproval(record: Omit<HeadlessRoughCutApprovalRecord, "evidenceDigest">): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const approval = { ...record, evidenceDigest: hash(stableJson(record)) };
    const path = this.approvalPath(record.planDigest);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  }

  private async readRoughCutApproval(planDigest: string): Promise<HeadlessRoughCutApprovalRecord> {
    const approval = JSON.parse(await readFile(this.approvalPath(planDigest), "utf8")) as HeadlessRoughCutApprovalRecord;
    const { evidenceDigest, ...unsignedApproval } = approval;
    const { planDigest: storedDigest, ...digestFields } = unsignedApproval;
    if (approval.schemaVersion !== 1 || storedDigest !== planDigest
      || !evidenceDigest || hash(stableJson(unsignedApproval)) !== evidenceDigest
      || hash(stableJson(digestFields)) !== planDigest) {
      throw new Error(`HEADLESS_ROUGH_CUT_APPROVAL_INVALID: persisted approval is invalid for ${planDigest}`);
    }
    return approval;
  }

  private async prepareRoughCut(request: HeadlessRoughCutRequest): Promise<PreparedRoughCut> {
    await this.open(request.projectId);
    const project = await this.store(request.projectId).load();
    if (project.timeline.sequence.id !== request.sequenceId) {
      throw new Error("HEADLESS_ROUGH_CUT_TARGET_MISMATCH: sequenceId does not match the persisted project");
    }
    if (!sameRevision(project.timeline.revision, request.plan.revision)) {
      throw new Error("HEADLESS_ROUGH_CUT_STALE_REVISION: rough-cut plan revision does not match the persisted project");
    }
    if (!request.plan.shots.length) throw new Error("HEADLESS_ROUGH_CUT_EMPTY_PLAN: rough-cut plan must contain at least one shot");
    const operations = structuredClone(request.operations ?? []);
    const sourceAudioPolicy = request.sourceAudioPolicy ?? "preserve-and-mix";
    const outputIntent = {
      sourceAudioPolicy,
      render: structuredClone(request.render),
      fcpxml: {
        path: request.fcpxml.path,
        target: structuredClone(request.fcpxml.target),
        overwrite: request.fcpxml.overwrite === true,
      },
    };
    const inputDigest = digestRoughCutPlan(request.plan, operations, outputIntent);
    const existingOccurrenceIds = new Set(project.timeline.sequence.occurrences.map(({ id }) => id));
    const resourceByMediaId = new Map(project.timeline.resources.map((resource) => [resource.id, resource]));
    const hasPrimaryStoryContent = project.timeline.sequence.occurrences.some(({ track }) => track === 0)
      || project.timeline.sequence.storyElements.length > 0;
    const provenance: HeadlessRoughCutShotProvenance[] = [];
    const planOperations: TimelineIrEditOperation[] = [];
    for (const shot of request.plan.shots) {
      const shotWithEvidence = shot as RoughCutShotWithEvidence;
      const occurrenceId = `rough-cut-${shot.order}`;
      if (existingOccurrenceIds.has(occurrenceId)) {
        throw new Error(`HEADLESS_ROUGH_CUT_OCCURRENCE_COLLISION: ${occurrenceId} already exists`);
      }
      existingOccurrenceIds.add(occurrenceId);
      const resource = resourceByMediaId.get(shot.sourceIdentity.mediaId);
      if (!resource) throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_NOT_FOUND: ${shot.sourceIdentity.mediaId}`);
      assertSourceIdentity(resource, shot.sourceIdentity);
      const sourceStartTime = shot.range.startTime ?? secondsToRational(shot.range.start);
      const durationTime = shot.range.durationTime ?? secondsToRational(shot.range.end - shot.range.start);
      assertSourceRange(resource, shot.range, sourceStartTime, durationTime);
      const appendToPrimaryStoryline = hasPrimaryStoryContent || planOperations.length > 0;
      planOperations.push({
        type: "insert-occurrence",
        ...(appendToPrimaryStoryline ? { placement: "append" as const } : {}),
        occurrence: {
          id: occurrenceId,
          name: `Rough cut ${shot.order}: ${shot.rationale}`,
          startTime: { value: "0", timescale: "1" },
          durationTime,
          sourceStartTime,
          track: 0,
          role: "video",
          mediaId: resource.id,
          binding: { provider: "framekit.rough-cut", kind: "occurrence", identity: `${inputDigest}:${shot.order}` },
        },
      });
      provenance.push({
        order: shot.order,
        occurrenceId,
        mediaId: resource.id,
        sourceIdentity: structuredClone(shot.sourceIdentity),
        sourceRange: structuredClone(shot.range),
        confidence: shot.confidence,
        matchedProperties: [...shot.matchedProperties],
        rationale: shot.rationale,
        ...(shotWithEvidence.evidence ? { evidence: structuredClone(shotWithEvidence.evidence) } : {}),
      });
    }
    const editOperations = [...planOperations, ...operations];
    const command: ProjectEditCommand = {
      schemaVersion: 1,
      target: { projectId: request.projectId, sequenceId: request.sequenceId },
      expectedRevision: structuredClone(request.plan.revision),
      operations: editOperations,
    };
    return { command, inputDigest, provenance, outputIntent };
  }

  private async previewPreparedRoughCut(
    request: HeadlessRoughCutRequest,
    prepared: PreparedRoughCut,
    timestamp: string,
    transaction = new ProjectTransactionService(this.store(request.projectId), { clock: () => timestamp }),
  ): Promise<{ preview: ProjectEditPreview; fcpxml: TimelineIrToFcpxmlResult }> {
    const rawPreview = await transaction.preview(prepared.command);
    const canonicalRevision: ContextRevision = {
      id: `ir:${timelineIrDigest(rawPreview.after.timeline)}`,
      sequence: rawPreview.before.timeline.revision.sequence + 1,
      timestamp,
    };
    const canonicalTimeline = structuredClone(rawPreview.after.timeline);
    canonicalTimeline.revision = canonicalRevision;
    const preview: ProjectEditPreview = {
      ...rawPreview,
      after: { ...rawPreview.after, timeline: canonicalTimeline },
    };
    const fcpxml = compileTimelineIrToFcpxml(canonicalTimeline, { target: request.fcpxml.target });
    return { preview, fcpxml };
  }
}

interface PreparedRoughCut {
  command: ProjectEditCommand;
  inputDigest: string;
  provenance: HeadlessRoughCutShotProvenance[];
  outputIntent: HeadlessRoughCutPreview["outputIntent"];
}

function createRoughCutApproval(
  fields: Omit<HeadlessRoughCutApprovalRecord, "schemaVersion" | "planDigest" | "evidenceDigest">,
): Omit<HeadlessRoughCutApprovalRecord, "evidenceDigest"> {
  const digestFields = { schemaVersion: 1 as const, ...fields };
  const planDigest = hash(stableJson(digestFields));
  return { ...digestFields, planDigest };
}

function digestRoughCutPlan(
  plan: RoughCutPlan,
  operations: TimelineIrEditOperation[],
  outputIntent: HeadlessRoughCutPreview["outputIntent"],
): string {
  return createHash("sha256").update(stableJson({ plan, operations, outputIntent })).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function assertSourceIdentity(resource: TimelineIr["resources"][number], source: RoughCutPlan["shots"][number]["sourceIdentity"]): void {
  if (resource.source !== source.source) throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MISMATCH: source path differs for ${source.mediaId}`);
  if (source.sourceDigest !== undefined && resource.sourceDigest !== source.sourceDigest) {
    throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MISMATCH: source digest differs for ${source.mediaId}`);
  }
  if (source.mediaKind !== undefined && resource.mediaKind !== source.mediaKind) {
    throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MISMATCH: media kind differs for ${source.mediaId}`);
  }
  if (resource.mediaKind !== "video") throw new Error(`HEADLESS_ROUGH_CUT_VIDEO_REQUIRED: ${source.mediaId}`);
  if (source.duration !== undefined && resource.metadata?.durationTime !== undefined
    && Math.abs(source.duration - rationalSeconds(resource.metadata.durationTime)) > 0.01) {
    throw new Error(`HEADLESS_ROUGH_CUT_SOURCE_MISMATCH: source duration differs for ${source.mediaId}`);
  }
}

function assertSourceRange(
  resource: TimelineIr["resources"][number],
  range: RoughCutPlan["shots"][number]["range"],
  sourceStartTime: TimelineIr["sequence"]["frameDuration"],
  durationTime: TimelineIr["sequence"]["frameDuration"],
): void {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error("HEADLESS_ROUGH_CUT_RANGE_INVALID: source range must be finite and non-empty");
  }
  if (resource.metadata?.durationTime !== undefined && range.end > rationalSeconds(resource.metadata.durationTime) + 0.001) {
    throw new Error(`HEADLESS_ROUGH_CUT_RANGE_INVALID: source range exceeds ${resource.id}`);
  }
  if (rationalSeconds(sourceStartTime) < 0 || rationalSeconds(durationTime) <= 0
    || Math.abs(rationalSeconds(sourceStartTime) - range.start) > 0.001
    || Math.abs(rationalSeconds(durationTime) - (range.end - range.start)) > 0.001) {
    throw new Error("HEADLESS_ROUGH_CUT_RANGE_INVALID: rational source range must be non-negative and non-empty");
  }
}

function secondsToRational(seconds: number): { value: string; timescale: string } {
  const timescale = 1_000_000;
  const value = Math.round(seconds * timescale);
  const divisor = greatestCommonDivisor(Math.abs(value), timescale);
  return { value: String(value / divisor), timescale: String(timescale / divisor) };
}

function rationalSeconds(time: { value: string; timescale: string }): number {
  return Number(time.value) / Number(time.timescale);
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1;
}

function sameRevision(left: TimelineIr["revision"], right: TimelineIr["revision"]): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}

function selectFcpxmlMetadata(result: TimelineIrToFcpxmlResult): HeadlessRoughCutPreview["fcpxml"] {
  return {
    digest: result.digest,
    target: structuredClone(result.target),
    destination: structuredClone(result.destination),
    coverage: structuredClone(result.coverage),
    provenance: structuredClone(result.provenance),
  };
}

async function writeVerifiedFcpxml(path: string, xml: string, digest: string, overwrite: boolean): Promise<{ path: string; digest: string; bytes: number; verified: true }> {
  await mkdir(dirname(path), { recursive: true });
  if (!overwrite) {
    try {
      await readFile(path);
      throw new Error(`HEADLESS_ROUGH_CUT_FCPXML_EXISTS: refusing to overwrite ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, xml, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
  const persisted = await readFile(path, "utf8");
  const persistedDigest = createHash("sha256").update(persisted).digest("hex");
  if (persistedDigest !== digest) throw new Error("HEADLESS_ROUGH_CUT_FCPXML_VERIFY_FAILED: persisted XML digest differs from the compiled artifact");
  return { path, digest, bytes: Buffer.byteLength(persisted), verified: true };
}

function toSummary(project: FramekitProjectDocument, path: string): HeadlessProjectSummary {
  return {
    projectId: project.timeline.project.id,
    projectName: project.timeline.project.name,
    sequenceId: project.timeline.sequence.id,
    sequenceName: project.timeline.sequence.name,
    revision: project.timeline.revision,
    path,
  };
}

function validateProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId)) throw new Error("HEADLESS_PROJECT_INVALID: projectId must be a safe logical identifier");
}

function validateRenderId(renderId: string): void {
  if (!/^render-[0-9a-f-]{36}$/.test(renderId)) throw new Error("HEADLESS_RENDER_INVALID: renderId is invalid");
}

function validateExecutionId(executionId: string): void {
  if (!/^rough-cut-[0-9a-f-]{36}$/.test(executionId)) throw new Error("HEADLESS_ROUGH_CUT_EXECUTION_INVALID: executionId is invalid");
}

function validatePlanDigest(planDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(planDigest)) throw new Error("HEADLESS_ROUGH_CUT_APPROVAL_INVALID: planDigest is invalid");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
