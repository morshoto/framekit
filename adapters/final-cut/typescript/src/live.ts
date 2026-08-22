import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { withCanonicalTimelineMode } from "@framekit/runtime";
import type {
  ContextRevision,
  EditOperation,
  EditorChange,
  EditorLiveState,
  EditorIdentity,
  RuntimeCapabilities,
  LiveEditorStatePort,
  ProjectCatalog,
  ProjectSnapshot,
  ProjectSelection,
} from "@framekit/runtime";

export const FINAL_CUT_LIVE_PROTOCOL_VERSION = 1;

/** Shared deterministic endpoint used by both the Node client and Swift host. */
export const DEFAULT_FINAL_CUT_LIVE_SOCKET = join(
  homedir(),
  "Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock",
);

export type FinalCutLiveMethod = "capabilities" | "state" | "changes" | "projects" | "select-project" | "snapshot" | "apply" | "restore";

export interface FinalCutLiveRequest {
  version: number;
  id: string;
  method: FinalCutLiveMethod;
  afterSequence?: number;
  waitMs?: number;
  projectId?: string;
  sequenceId?: string;
  operation?: EditOperation;
  expectedRevision?: ContextRevision;
  snapshot?: ProjectSnapshot;
}

export type FinalCutLiveResponse =
  | {
      version: number;
      id: string;
      ok: true;
      result: {
        identity: EditorIdentity;
        capabilities: RuntimeCapabilities;
        state?: EditorLiveState;
        changes?: EditorChange[];
        catalog?: ProjectCatalog;
        snapshot?: ProjectSnapshot;
        revision?: ContextRevision;
      };
    }
  | {
      version: number;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface FinalCutLiveTransport {
  request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse>;
}

/** Newline-delimited JSON transport for the local Workflow Extension socket. */
export class UnixSocketFinalCutLiveTransport implements FinalCutLiveTransport {
  public constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 2_000,
  ) {}

  public request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let socket: Socket | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (socket && !socket.destroyed) socket.destroy();
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`FINAL_CUT_LIVE_TIMEOUT: ${this.socketPath}`)));
      }, this.timeoutMs);

      socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket?.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        const line = buffer.slice(0, newline);
        finish(() => {
          try {
            resolve(JSON.parse(line) as FinalCutLiveResponse);
          } catch (error) {
            reject(new Error(`FINAL_CUT_LIVE_PROTOCOL: invalid JSON response (${String(error)})`));
          }
        });
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        finish(() => reject(new Error(`FINAL_CUT_LIVE_UNAVAILABLE: ${error.message}`)));
      });
      socket.on("end", () => {
        if (!settled) {
          clearTimeout(timer);
          finish(() => reject(new Error("FINAL_CUT_LIVE_PROTOCOL: bridge closed before response")));
        }
      });
    });
  }
}

export class FinalCutLiveAdapter implements LiveEditorStatePort {
  public constructor(
    private readonly transport: FinalCutLiveTransport,
    private readonly socketPath = "configured-socket",
  ) {}

  public async getIdentity(): Promise<EditorIdentity> {
    const response = await this.request({ method: "capabilities" });
    return response.identity;
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    const response = await this.request({ method: "capabilities" });
    return withCanonicalTimelineMode(response.capabilities);
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.editor.timelineSnapshotRead || capabilities.editor.canonicalTimelineMode === "metadata-only") {
      if (!capabilities.editor.projectCatalogRead || !capabilities.editor.projectSelection) {
        throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical snapshot targeting");
      }
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical snapshot");
    }
    const response = await this.request({ method: "snapshot" });
    if (!response.snapshot) throw new Error("FINAL_CUT_LIVE_PROTOCOL: snapshot response was empty");
    validateCanonicalSnapshot(response.snapshot);
    validateSnapshotTarget(response.snapshot, await this.listProjects());
    return response.snapshot;
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    const capabilities = await this.getCapabilities();
    if (capabilities.editor.canonicalTimelineMode !== "canonical-write") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical mutation");
    }
    const response = await this.request({ method: "apply", operation, expectedRevision });
    if (!response.revision) throw new Error("FINAL_CUT_LIVE_PROTOCOL: apply response revision was empty");
    return response.revision;
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    const capabilities = await this.getCapabilities();
    if (capabilities.editor.canonicalTimelineMode !== "canonical-write") {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical rollback");
    }
    await this.request({ method: "restore", snapshot, expectedRevision });
  }

  public async readLiveState(): Promise<EditorLiveState> {
    const response = await this.request({ method: "state" });
    if (!response.state) throw new Error("FINAL_CUT_LIVE_PROTOCOL: state response was empty");
    return response.state;
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    const response = await this.request({
      method: "changes",
      afterSequence: revision.sequence,
      waitMs,
    });
    return response.changes ?? [];
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const response = await this.request({ method: "projects" });
    if (!response.catalog) throw new Error("FINAL_CUT_LIVE_PROTOCOL: project catalog response was empty");
    return response.catalog;
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const response = await this.request({
      method: "select-project",
      projectId: selection.projectId,
      sequenceId: selection.sequenceId,
    });
    if (!response.catalog) throw new Error("FINAL_CUT_LIVE_PROTOCOL: project selection response was empty");
    return response.catalog;
  }

  private async request(input: Pick<FinalCutLiveRequest, "method" | "afterSequence" | "waitMs" | "projectId" | "sequenceId" | "operation" | "expectedRevision" | "snapshot">) {
    const response = await this.transport.request({
      version: FINAL_CUT_LIVE_PROTOCOL_VERSION,
      id: randomUUID(),
      ...input,
    });
    if (response.version !== FINAL_CUT_LIVE_PROTOCOL_VERSION) {
      throw new Error(`FINAL_CUT_LIVE_PROTOCOL: unsupported version ${response.version}`);
    }
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }
}

export function createFinalCutLiveAdapter(
  socketPath = process.env.FRAMEKIT_FINAL_CUT_SOCKET ?? DEFAULT_FINAL_CUT_LIVE_SOCKET,
): FinalCutLiveAdapter {
  return new FinalCutLiveAdapter(new UnixSocketFinalCutLiveTransport(socketPath), socketPath);
}

function validateCanonicalSnapshot(snapshot: ProjectSnapshot): void {
  requireNonEmpty(snapshot.projectId, "project id");
  requireNonEmpty(snapshot.projectName, "project name");
  requireNonEmpty(snapshot.timeline?.id, "timeline id");
  requireNonEmpty(snapshot.timeline?.name, "timeline name");
  requireFiniteNonNegative(snapshot.timeline?.duration, "timeline duration");
  requireRational(snapshot.timeline?.durationTime, "timeline duration time");
  requireArray(snapshot.timeline?.clips, "timeline clips");
  requireArray(snapshot.timeline?.storyElements, "timeline story elements");
  requireArray(snapshot.timeline?.markers, "timeline markers");
  requireArray(snapshot.timeline?.captions, "timeline captions");
  requireArray(snapshot.media, "media references");
  requireNonEmpty(snapshot.revision?.id, "revision id");
  if (!Number.isInteger(snapshot.revision?.sequence) || snapshot.revision.sequence < 0) {
    protocolError("revision sequence must be a non-negative integer");
  }
  requireNonEmpty(snapshot.revision?.timestamp, "revision timestamp");

  const mediaIds = uniqueIds(snapshot.media, ({ mediaId }) => mediaId, "media");
  uniqueIds(snapshot.timeline.markers, ({ id }) => id, "marker");
  uniqueIds(snapshot.timeline.captions, ({ id }) => id, "caption");
  const occurrenceIds = uniqueIds(snapshot.timeline.clips, ({ id }) => id, "timeline occurrence");
  const storyElementIds = uniqueIds(snapshot.timeline.storyElements, ({ id }) => id, "story element");
  for (const clip of snapshot.timeline.clips) {
    requireFiniteNonNegative(clip.start, `occurrence ${clip.id} start`);
    requireFiniteNonNegative(clip.duration, `occurrence ${clip.id} duration`);
    if (!Number.isInteger(clip.track)) protocolError(`occurrence ${clip.id} track must be an integer`);
    requireRational(clip.startTime, `occurrence ${clip.id} start time`);
    requireRational(clip.durationTime, `occurrence ${clip.id} duration time`);
    if (clip.mediaId && !mediaIds.has(clip.mediaId)) {
      protocolError(`occurrence ${clip.id} references missing media ${clip.mediaId}`);
    }
    if (!storyElementIds.has(clip.id)) protocolError(`occurrence ${clip.id} has no storyline relationship`);
  }
  for (const occurrenceId of occurrenceIds) {
    if (mediaIds.has(occurrenceId)) protocolError(`occurrence identity ${occurrenceId} must be distinct from media identity`);
  }
}

function validateSnapshotTarget(snapshot: ProjectSnapshot, catalog: ProjectCatalog): void {
  if (catalog.activeProjectId !== snapshot.projectId || catalog.activeSequenceId !== snapshot.timeline.id) {
    throw new Error(
      `TARGET_MISMATCH: live canonical snapshot ${snapshot.projectId}/${snapshot.timeline.id} does not match active target ${catalog.activeProjectId ?? "unknown"}/${catalog.activeSequenceId ?? "unknown"}`,
    );
  }
  const project = catalog.projects.find(({ id }) => id === snapshot.projectId);
  if (!project?.sequences.some(({ id }) => id === snapshot.timeline.id)) {
    protocolError("active canonical snapshot target is absent from the project catalog");
  }
}

function uniqueIds<T>(values: T[], identify: (value: T) => string, kind: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const id = identify(value);
    requireNonEmpty(id, `${kind} id`);
    if (ids.has(id)) protocolError(`duplicate ${kind} id ${id}`);
    ids.add(id);
  }
  return ids;
}

function requireArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) protocolError(`${field} must be an array`);
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) protocolError(`${field} must be a non-empty string`);
}

function requireFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    protocolError(`${field} must be finite and non-negative`);
  }
}

function requireRational(value: unknown, field: string): void {
  const candidate = value as { value?: unknown; timescale?: unknown } | undefined;
  if (
    !candidate
    || typeof candidate.value !== "string"
    || !/^-?\d+$/.test(candidate.value)
    || typeof candidate.timescale !== "string"
    || !/^\d+$/.test(candidate.timescale)
    || BigInt(candidate.timescale) <= 0n
  ) {
    protocolError(`${field} must use an integer value and positive timescale`);
  }
}

function protocolError(message: string): never {
  throw new Error(`FINAL_CUT_LIVE_PROTOCOL: ${message}`);
}
