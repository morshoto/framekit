import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
} from "@framekit/runtime";
import {
  compileTimelineIrToFcpxml,
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
}

export interface HeadlessRoughCutPreview extends ProjectEditPreview {
  plan: RoughCutPlan;
  planDigest: string;
  provenance: HeadlessRoughCutShotProvenance[];
  outputIntent: {
    render: FramekitRenderParameters;
    fcpxml: { path: string; target: TimelineIrToFcpxmlTarget; overwrite: boolean };
  };
  fcpxml: Pick<TimelineIrToFcpxmlResult, "digest" | "target" | "destination" | "coverage" | "provenance">;
}

export interface HeadlessRoughCutExecution extends HeadlessRoughCutPreview {
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
    const transaction = new ProjectTransactionService(this.store(request.projectId), { clock: this.clock });
    const preview = await transaction.preview(prepared.command);
    const fcpxml = compileTimelineIrToFcpxml(preview.after.timeline, { target: request.fcpxml.target });
    return {
      ...preview,
      plan: structuredClone(request.plan),
      planDigest: prepared.planDigest,
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
    if (request.planDigest !== prepared.planDigest) {
      throw new Error("HEADLESS_ROUGH_CUT_PLAN_MISMATCH: planDigest does not match the submitted rough-cut plan");
    }

    const transaction = new ProjectTransactionService(this.store(request.projectId), { clock: this.clock });
    const preview = await transaction.preview(prepared.command);
    const fcpxml = compileTimelineIrToFcpxml(preview.after.timeline, { target: request.fcpxml.target });
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
    return {
      ...preview,
      plan: structuredClone(request.plan),
      planDigest: prepared.planDigest,
      provenance: prepared.provenance,
      outputIntent: prepared.outputIntent,
      fcpxml: selectFcpxmlMetadata(fcpxml),
      committed: true,
      render: { renderId, status: "passed", outcome },
      fcpxmlArtifact,
      transaction: committed,
    };
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

  private async saveRender(record: HeadlessRenderRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${record.renderId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
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
    const planDigest = digestRoughCutPlan(request.plan);
    const existingOccurrenceIds = new Set(project.timeline.sequence.occurrences.map(({ id }) => id));
    const resourceByMediaId = new Map(project.timeline.resources.map((resource) => [resource.id, resource]));
    const provenance: HeadlessRoughCutShotProvenance[] = [];
    const operations: TimelineIrEditOperation[] = [];
    for (const shot of request.plan.shots) {
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
      operations.push({
        type: "insert-occurrence",
        placement: "append",
        occurrence: {
          id: occurrenceId,
          name: `Rough cut ${shot.order}: ${shot.rationale}`,
          startTime: { value: "0", timescale: "1" },
          durationTime,
          sourceStartTime,
          track: 0,
          role: "video",
          mediaId: resource.id,
          binding: { provider: "framekit.rough-cut", kind: "occurrence", identity: `${planDigest}:${shot.order}` },
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
      });
    }
    const command: ProjectEditCommand = {
      schemaVersion: 1,
      target: { projectId: request.projectId, sequenceId: request.sequenceId },
      expectedRevision: structuredClone(request.plan.revision),
      operations,
    };
    const outputIntent = {
      render: structuredClone(request.render),
      fcpxml: {
        path: request.fcpxml.path,
        target: structuredClone(request.fcpxml.target),
        overwrite: request.fcpxml.overwrite === true,
      },
    };
    return { command, planDigest, provenance, outputIntent };
  }
}

interface PreparedRoughCut {
  command: ProjectEditCommand;
  planDigest: string;
  provenance: HeadlessRoughCutShotProvenance[];
  outputIntent: HeadlessRoughCutPreview["outputIntent"];
}

function digestRoughCutPlan(plan: RoughCutPlan): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
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
