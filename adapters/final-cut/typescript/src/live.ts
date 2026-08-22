import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { withCanonicalTimelineMode } from "@framekit/runtime";
import type {
  ContextRevision,
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

export type FinalCutLiveMethod = "capabilities" | "state" | "changes" | "projects" | "select-project" | "snapshot";

export interface FinalCutLiveRequest {
  version: number;
  id: string;
  method: FinalCutLiveMethod;
  afterSequence?: number;
  waitMs?: number;
  projectId?: string;
  sequenceId?: string;
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
    if (!capabilities.editor.timelineSnapshotRead) {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical snapshot");
    }
    const response = await this.request({ method: "snapshot" });
    if (!response.snapshot) throw new Error("FINAL_CUT_LIVE_PROTOCOL: snapshot response was empty");
    return response.snapshot;
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

  private async request(input: Pick<FinalCutLiveRequest, "method" | "afterSequence" | "waitMs" | "projectId" | "sequenceId">) {
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
