import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  type TimelineIr,
} from "@framekit/runtime";

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
